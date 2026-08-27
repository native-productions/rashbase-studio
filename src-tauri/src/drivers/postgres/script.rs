//! Splitting a `.sql` file back into the statements it was written from.
//!
//! # Why not split on `;`
//!
//! Because a semicolon means "end of statement" in exactly one of the eight
//! places it can appear. It is ordinary text inside `'…'`, inside `E'…'` with
//! its own escape rule, inside `"…"`, inside `--` to the end of the line,
//! inside `/* … */` which in Postgres *nests*, inside `$tag$ … $tag$` which is
//! how every function body and every `DO` block is written, and inside the raw
//! data block that follows `COPY … FROM stdin`. Every naive importer is a
//! `split(';')` and every one of them corrupts a dump that contains a function
//! or a value with a semicolon in it.
//!
//! So this is a lexer, not a split. It reads a line at a time and carries its
//! state across lines, which keeps a file larger than memory to a fixed cost
//! while still letting a single statement span as many lines as it likes.
//!
//! # Bytes, not text
//!
//! Lines are read as bytes. The syntax this scans for is all ASCII, and a
//! UTF-8 continuation byte is never an ASCII byte, so scanning bytes is exact.
//! It also means a `COPY` data block reaches the wire as the bytes that were on
//! disk, with no decode and re-encode in the middle. Statement text is turned
//! into a `String` at the boundary, and a file that is not UTF-8 is refused
//! there with a message that says what to do about it.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use flate2::read::GzDecoder;

use crate::error::{Error, Result};

/// A script being read off disk, however it happens to be stored.
pub type FileScript = Script<Box<dyn BufRead + Send>>;

/// Opens a `.sql` file, transparently through gzip, and says which it was.
///
/// The magic number decides, not the extension. A file this application wrote
/// as `shop.sql.gz` and someone then renamed is still a gzip stream, and an
/// importer that reads the name instead of the bytes hands the decompressor's
/// output to the lexer as if it were SQL.
pub fn open(path: &Path) -> Result<(FileScript, bool)> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 2];
    let read = file.read(&mut magic)?;
    let compressed = read == 2 && magic == [0x1f, 0x8b];
    file.seek(SeekFrom::Start(0))?;

    // 64 KiB, so a dump of short statements is a handful of syscalls per
    // megabyte rather than one per line.
    let reader: Box<dyn BufRead + Send> = if compressed {
        Box::new(BufReader::with_capacity(
            64 * 1024,
            GzDecoder::new(BufReader::with_capacity(64 * 1024, file)),
        ))
    } else {
        Box::new(BufReader::with_capacity(64 * 1024, file))
    };
    Ok((Script::new(reader), compressed))
}

/// What a statement is, to the degree that reading its first few words can say.
///
/// Deliberately shallow. This exists so the dialog can count what is in a file
/// and so the two skip switches can find their targets — not to understand SQL.
/// Anything not recognised is [`Kind::Other`], and `Other` runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Create,
    Alter,
    Drop,
    Insert,
    /// `COPY … FROM stdin`. The rows are not in the statement; they follow it.
    Copy,
    Grant,
    Revoke,
    Set,
    Comment,
    /// `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and the rest.
    ///
    /// Its own kind because an importer that opens its own transaction cannot
    /// run these: the file's `COMMIT` would commit the importer's transaction
    /// halfway through, and everything after it would apply outside one.
    Transaction,
    Other,
}

impl Kind {
    /// The word the dialog counts these under.
    pub fn label(self) -> &'static str {
        match self {
            Kind::Create => "create",
            Kind::Alter => "alter",
            Kind::Drop => "drop",
            Kind::Insert => "insert",
            Kind::Copy => "copy",
            Kind::Grant => "grant",
            Kind::Revoke => "revoke",
            Kind::Set => "set",
            Kind::Comment => "comment",
            Kind::Transaction => "transaction",
            Kind::Other => "other",
        }
    }
}

/// One statement, and where in the file it came from.
#[derive(Debug, Clone)]
pub struct Statement {
    pub kind: Kind,
    /// Exactly what was in the file, terminator included.
    pub text: String,
    /// The relation this is about, unquoted and schema-qualified where the file
    /// said so. Only read for the kinds where it is unambiguous.
    pub target: Option<String>,
    /// 1-based, and the line the statement *started* on. The line it ended on
    /// is no use to someone opening the file to look at what failed.
    pub line: usize,
    /// Whether a `COPY` data block follows this statement.
    pub copy_data: bool,
    /// Whether this names a role, an owner, or a grant — none of which mean
    /// anything on a server other than the one the dump came from.
    pub ownership: bool,
}

/// Where the lexer is, between one byte and the next.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    Normal,
    /// `escapes` is true for `E'…'`, where a backslash escapes the next byte.
    /// In a plain string it does not, and treating it as if it did is how an
    /// importer swallows the quote that ends a Windows path.
    Single { escapes: bool },
    Double,
    /// The full delimiter, `$$` or `$tag$`, which is what has to reappear.
    Dollar(Vec<u8>),
    /// Postgres nests block comments. A flat "in a comment" flag closes on the
    /// first `*/` and drops the rest of an outer comment into the statement.
    Block(u32),
}

/// A `.sql` file, being read.
pub struct Script<R: BufRead> {
    reader: R,
    mode: Mode,
    /// The current line, and how far into it the scanner has got.
    line: Vec<u8>,
    at: usize,
    /// 1-based number of the line in `line`.
    line_no: usize,
    /// Bytes consumed, for progress that can be held against the file size.
    bytes: u64,
    /// The statement being accumulated.
    pending: Vec<u8>,
    /// The line `pending` started on.
    pending_line: usize,
    /// A `COPY` data block is open and has not been read out.
    copy_open: bool,
    /// Whether anything other than whitespace and comments has gone into
    /// `pending` yet. Until it has, the statement has not really started and
    /// its line number should keep moving forward — otherwise every statement
    /// with a comment above it reports the blank line after the last one.
    saw_code: bool,
    eof: bool,
}

impl<R: BufRead> Script<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            mode: Mode::Normal,
            line: Vec::new(),
            at: 0,
            line_no: 0,
            bytes: 0,
            pending: Vec::new(),
            pending_line: 1,
            copy_open: false,
            saw_code: false,
            eof: false,
        }
    }

    /// Bytes read so far. Uncompressed bytes when the file was gzipped, which
    /// is the number to hold against `bytes_total` from the same source.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Fills `line` with the next line, or reports that there are none left.
    fn fill(&mut self) -> Result<bool> {
        if self.at < self.line.len() {
            return Ok(true);
        }
        self.line.clear();
        self.at = 0;
        let n = self.reader.read_until(b'\n', &mut self.line)?;
        if n == 0 {
            self.eof = true;
            return Ok(false);
        }
        self.bytes += n as u64;
        self.line_no += 1;
        Ok(true)
    }

    /// The next statement, or `None` at the end of the file.
    ///
    /// An open `COPY` data block that the caller did not read is drained first.
    /// The alternative is returning several million rows of tab-separated data
    /// as if they were statements, which is a failure mode worth spending four
    /// lines to make impossible.
    pub fn next_statement(&mut self) -> Result<Option<Statement>> {
        while self.copy_open {
            if self.next_copy_line()?.is_none() {
                break;
            }
        }

        loop {
            if !self.fill()? {
                // A file whose last statement has no terminator. psql runs it;
                // so does this.
                return self.finish();
            }

            // Nothing but blank lines and comments so far, so the statement
            // has not started yet and it starts here — not at the blank line
            // that followed the previous one.
            if !self.saw_code {
                self.pending_line = self.line_no;
            }

            if let Some(end) = self.scan() {
                let taken = &self.line[self.at..end];
                self.pending.extend_from_slice(taken);
                self.at = end;
                if let Some(statement) = self.take()? {
                    return Ok(Some(statement));
                }
                continue;
            }

            self.pending.extend_from_slice(&self.line[self.at..]);
            self.at = self.line.len();
        }
    }

    /// Whatever is left in `pending` at the end of the file.
    fn finish(&mut self) -> Result<Option<Statement>> {
        if !self.saw_code {
            self.pending.clear();
            return Ok(None);
        }
        self.take()
    }

    /// Turns `pending` into a statement, or discards it if it is only comments.
    fn take(&mut self) -> Result<Option<Statement>> {
        let bytes = std::mem::take(&mut self.pending);
        self.saw_code = false;
        let text = String::from_utf8(bytes).map_err(|_| {
            Error::other(format!(
                "Line {} of this file is not UTF-8. Re-export it with client_encoding set to UTF8.",
                self.pending_line
            ))
        })?;

        let head = head_of(&text);
        if head.is_empty() {
            // Comments and blank lines between statements. Not a statement, and
            // not an error either.
            return Ok(None);
        }

        let (kind, target) = classify(&head);
        let copy_data = kind == Kind::Copy && head.to_ascii_lowercase().contains("from stdin");
        if copy_data {
            self.copy_open = true;
            // The newline after `COPY … FROM stdin;` belongs to the statement,
            // not to the block. Handing it over as a row would send Postgres a
            // blank line where it is expecting the first tuple.
            if self.line[self.at..].iter().all(|b| b.is_ascii_whitespace()) {
                self.at = self.line.len();
            }
        }

        Ok(Some(Statement {
            kind,
            ownership: is_ownership(&head, kind),
            text,
            target,
            line: self.pending_line,
            copy_data,
        }))
    }

    /// The next row of an open `COPY` data block, newline included, or `None`
    /// once the terminator has been passed.
    ///
    /// Bytes rather than text: this goes straight onto the wire, and decoding
    /// it to re-encode it would be two chances to change what the file said.
    pub fn next_copy_line(&mut self) -> Result<Option<&[u8]>> {
        if !self.copy_open {
            return Ok(None);
        }
        if !self.fill()? {
            // A truncated dump. The `COPY` will fail on the server with its own
            // words, which is a better message than any this could invent.
            self.copy_open = false;
            return Ok(None);
        }

        let start = self.at;
        self.at = self.line.len();
        if trimmed_end(&self.line[start..]) == b"\\." {
            self.copy_open = false;
            return Ok(None);
        }
        Ok(Some(&self.line[start..]))
    }

    /// Reads out an open data block without keeping it, and says how many rows
    /// it held. What the preflight wants: the count, not the bytes.
    pub fn skip_copy_data(&mut self) -> Result<u64> {
        let mut rows = 0;
        while self.next_copy_line()?.is_some() {
            rows += 1;
        }
        Ok(rows)
    }

    /// Scans from `at` to the end of the line, updating the mode.
    ///
    /// Returns the index just past a `;` that ends a statement, or `None` if
    /// the line ended without one.
    fn scan(&mut self) -> Option<usize> {
        // Moved out and back rather than borrowed: the scanner writes `mode`
        // on the same passes it reads the line, and the two cannot both be
        // borrows of `self`.
        let line = std::mem::take(&mut self.line);
        let end = self.scan_line(&line);
        self.line = line;
        end
    }

    fn scan_line(&mut self, line: &[u8]) -> Option<usize> {
        let mut i = self.at;

        while i < line.len() {
            let b = line[i];

            // Dollar quoting is handled ahead of the others because its
            // delimiter lives inside the mode: the comparison has to finish
            // before the mode can be written over.
            if let Mode::Dollar(tag) = &self.mode {
                let hit = b == b'$' && line[i..].starts_with(tag.as_slice());
                i += if hit { tag.len() } else { 1 };
                if hit {
                    self.mode = Mode::Normal;
                }
                continue;
            }

            if matches!(self.mode, Mode::Normal) && !b.is_ascii_whitespace() {
                let opens_comment = (b == b'-' && line.get(i + 1) == Some(&b'-'))
                    || (b == b'/' && line.get(i + 1) == Some(&b'*'));
                if !opens_comment {
                    self.saw_code = true;
                }
            }

            match self.mode {
                Mode::Dollar(_) => unreachable!("handled above"),

                Mode::Normal => match b {
                    b';' => return Some(i + 1),
                    b'\'' => {
                        // `E'…'` is the one string where a backslash escapes.
                        // The `E` has to be a word of its own: the `e` in
                        // `nocase'x'` does not make an escape string.
                        let escapes = i > 0
                            && (line[i - 1] | 0x20) == b'e'
                            && (i < 2 || !is_ident_byte(line[i - 2]));
                        self.mode = Mode::Single { escapes };
                        i += 1;
                    }
                    b'"' => {
                        self.mode = Mode::Double;
                        i += 1;
                    }
                    // To the end of the line. The text stays in the statement,
                    // so what is sent back reads the way the file did.
                    b'-' if line.get(i + 1) == Some(&b'-') => return None,
                    b'/' if line.get(i + 1) == Some(&b'*') => {
                        self.mode = Mode::Block(1);
                        i += 2;
                    }
                    b'$' => match dollar_tag(line, i) {
                        Some(tag) => {
                            i += tag.len();
                            self.mode = Mode::Dollar(tag);
                        }
                        // `$1` in a prepared statement, or a lone `$`.
                        None => i += 1,
                    },
                    _ => i += 1,
                },

                Mode::Single { escapes } => {
                    if escapes && b == b'\\' {
                        i += 2;
                    } else if b == b'\'' {
                        // `''` is one quote, not the end of the string.
                        if line.get(i + 1) == Some(&b'\'') {
                            i += 2;
                        } else {
                            self.mode = Mode::Normal;
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }

                Mode::Double => {
                    if b == b'"' {
                        if line.get(i + 1) == Some(&b'"') {
                            i += 2;
                        } else {
                            self.mode = Mode::Normal;
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }

                Mode::Block(depth) => {
                    if b == b'/' && line.get(i + 1) == Some(&b'*') {
                        self.mode = Mode::Block(depth + 1);
                        i += 2;
                    } else if b == b'*' && line.get(i + 1) == Some(&b'/') {
                        self.mode = if depth <= 1 {
                            Mode::Normal
                        } else {
                            Mode::Block(depth - 1)
                        };
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
        }
        None
    }
}

/// The delimiter starting at `i`, if this `$` opens a dollar-quoted string.
///
/// `$$`, `$body$`, `$_1$` are delimiters. `$1` is a parameter placeholder and
/// `$` on its own is arithmetic in some other dialect. The rule is Postgres':
/// the tag is empty or begins with a letter or underscore.
fn dollar_tag(line: &[u8], i: usize) -> Option<Vec<u8>> {
    let mut j = i + 1;
    if line.get(j) == Some(&b'$') {
        return Some(b"$$".to_vec());
    }
    match line.get(j) {
        Some(&b) if b.is_ascii_alphabetic() || b == b'_' => j += 1,
        _ => return None,
    }
    while let Some(&b) = line.get(j) {
        if is_ident_byte(b) {
            j += 1;
        } else {
            break;
        }
    }
    if line.get(j) == Some(&b'$') {
        Some(line[i..=j].to_vec())
    } else {
        None
    }
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn trimmed_end(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

// ---------------------------------------------------------------------------
// Reading the front of a statement
// ---------------------------------------------------------------------------

/// The first 200 characters of a statement with comments and runs of
/// whitespace collapsed, which is all any classification below needs.
///
/// Bounded because a statement can be a megabyte of `values` rows and none of
/// this cares past the first few words. Comments are dropped rather than
/// skipped over, because `/* x */ INSERT` and `INSERT` are the same statement
/// and only one of them classifies if the comment stays.
fn head_of(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let mut space = true;

    while i < bytes.len() && out.len() < 200 {
        let b = bytes[i];
        if b == b'-' && bytes.get(i + 1) == Some(&b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if b.is_ascii_whitespace() {
            if !space {
                out.push(' ');
                space = true;
            }
            i += 1;
            continue;
        }
        space = false;
        // Multi-byte characters can only appear inside an identifier or a
        // literal, both of which are copied through unchanged.
        let ch_len = utf8_len(b);
        out.push_str(&text[i..(i + ch_len).min(text.len())]);
        i += ch_len;
    }

    out.trim().to_string()
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// The statement's kind, and the relation it is about where that is certain.
fn classify(head: &str) -> (Kind, Option<String>) {
    let mut words = Words::new(head);
    let first = words.next_upper();

    match first.as_str() {
        "INSERT" => {
            // `INSERT INTO x.y`, and nothing else starts that way.
            let target = if words.next_upper() == "INTO" {
                words.relation()
            } else {
                None
            };
            (Kind::Insert, target)
        }
        "COPY" => (Kind::Copy, words.relation()),
        "GRANT" => (Kind::Grant, None),
        "REVOKE" => (Kind::Revoke, None),
        "SET" | "RESET" => (Kind::Set, None),
        "COMMENT" => (Kind::Comment, None),
        // `END` is also plpgsql's, but only ever inside a dollar-quoted body,
        // which is one statement and never reaches this.
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "SAVEPOINT" | "RELEASE" => {
            (Kind::Transaction, None)
        }
        "CREATE" | "ALTER" | "DROP" => {
            let kind = match first.as_str() {
                "CREATE" => Kind::Create,
                "ALTER" => Kind::Alter,
                _ => Kind::Drop,
            };
            let mut what = words.next_upper();
            // `CREATE UNLOGGED TABLE`, `CREATE OR REPLACE VIEW`, and the
            // `IF EXISTS` that follows `DROP TABLE` are all noise between the
            // verb and the name.
            loop {
                match what.as_str() {
                    "OR" | "REPLACE" | "UNLOGGED" | "TEMP" | "TEMPORARY" | "GLOBAL" | "LOCAL"
                    | "MATERIALIZED" | "FOREIGN" | "IF" | "NOT" | "EXISTS" | "ONLY" => {
                        what = words.next_upper();
                    }
                    _ => break,
                }
            }
            let target = if what == "TABLE" {
                // Skip a second `IF NOT EXISTS`, which sits after the noun.
                let mut peeked = words.relation();
                while matches!(peeked.as_deref(), Some("IF") | Some("NOT") | Some("EXISTS")) {
                    peeked = words.relation();
                }
                peeked
            } else {
                None
            };
            (kind, target)
        }
        _ => (Kind::Other, None),
    }
}

/// Whether this statement is about who owns something rather than what it is.
///
/// All of these name a role. A dump carries the roles of the server it came
/// from, and restoring it somewhere else stops on `role "shop_app" does not
/// exist` before a single row has moved.
fn is_ownership(head: &str, kind: Kind) -> bool {
    if matches!(kind, Kind::Grant | Kind::Revoke) {
        return true;
    }
    let upper = head.to_ascii_uppercase();
    if upper.contains(" OWNER TO ") {
        return true;
    }
    for prefix in [
        "CREATE ROLE ",
        "CREATE USER ",
        "CREATE GROUP ",
        "ALTER ROLE ",
        "ALTER USER ",
        "ALTER GROUP ",
        "DROP ROLE ",
        "DROP USER ",
        "DROP GROUP ",
        "SET SESSION AUTHORIZATION",
        "RESET SESSION AUTHORIZATION",
        "SET ROLE ",
        "RESET ROLE",
        // pg_dump emits it, and it needs to own the extension to succeed.
        "COMMENT ON EXTENSION ",
    ] {
        if upper.starts_with(prefix) {
            return true;
        }
    }
    false
}

/// Walks the words at the front of a statement.
struct Words<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl<'a> Words<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            text,
            at: 0,
        }
    }

    fn skip_space(&mut self) {
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    /// The next bare word, uppercased. Empty at the end.
    fn next_upper(&mut self) -> String {
        self.skip_space();
        let start = self.at;
        while self.at < self.bytes.len() && is_ident_byte(self.bytes[self.at]) {
            self.at += 1;
        }
        if start == self.at {
            // Not a word: a punctuation mark. Step over it so the caller cannot
            // spin here forever.
            self.at = (self.at + 1).min(self.bytes.len());
            return String::new();
        }
        self.text[start..self.at].to_ascii_uppercase()
    }

    /// The next relation name, unquoted, with its schema if the file gave one.
    ///
    /// Quotes come off because the point of the name here is matching it
    /// against `_prisma_migrations` and showing it in a list. What goes back to
    /// the server is always the statement's own text, never this.
    fn relation(&mut self) -> Option<String> {
        self.skip_space();
        let mut parts: Vec<String> = Vec::new();

        loop {
            if self.bytes.get(self.at) == Some(&b'"') {
                self.at += 1;
                let mut part = String::new();
                while self.at < self.bytes.len() {
                    if self.bytes[self.at] == b'"' {
                        if self.bytes.get(self.at + 1) == Some(&b'"') {
                            part.push('"');
                            self.at += 2;
                            continue;
                        }
                        self.at += 1;
                        break;
                    }
                    let len = utf8_len(self.bytes[self.at]);
                    part.push_str(&self.text[self.at..(self.at + len).min(self.text.len())]);
                    self.at += len;
                }
                parts.push(part);
            } else {
                let start = self.at;
                while self.at < self.bytes.len() && is_ident_byte(self.bytes[self.at]) {
                    self.at += 1;
                }
                if start == self.at {
                    break;
                }
                parts.push(self.text[start..self.at].to_string());
            }

            if self.bytes.get(self.at) == Some(&b'.') {
                self.at += 1;
                continue;
            }
            break;
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join("."))
        }
    }
}

/// Whether a name is a relation's, ignoring the schema and the case.
///
/// Postgres folds an unquoted name to lower case, so a file written by an ORM
/// always says `_prisma_migrations` in lower case. A file written by hand may
/// not, and the comparison costs nothing.
pub fn relation_is(target: Option<&str>, name: &str) -> bool {
    match target {
        Some(t) => t
            .rsplit('.')
            .next()
            .is_some_and(|last| last.eq_ignore_ascii_case(name)),
        None => false,
    }
}

/// The schema part of a qualified name.
///
/// `None` for a bare name, which means the file left it to `search_path` and
/// the caller has to ask the session which schema that is. Guessing `public`
/// here would be a schema the restore then resets sequences in for no reason.
pub fn schema_of(target: &str) -> Option<&str> {
    match target.rsplit_once('.') {
        Some((schema, _)) => schema.rsplit('.').next(),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statements(sql: &str) -> Vec<Statement> {
        let mut script = Script::new(std::io::Cursor::new(sql.as_bytes().to_vec()));
        let mut out = Vec::new();
        while let Some(s) = script.next_statement().unwrap() {
            if s.copy_data {
                script.skip_copy_data().unwrap();
            }
            out.push(s);
        }
        out
    }

    /// The whole reason this file is a lexer. Each of these is one statement,
    /// and every one of them is two or more to a `split(';')`.
    #[test]
    fn a_semicolon_inside_a_quote_does_not_end_a_statement() {
        let cases = [
            "INSERT INTO t VALUES ('a;b');",
            "INSERT INTO t VALUES (E'a\\';b');",
            "INSERT INTO \"we;ird\" VALUES (1);",
            "SELECT 1; -- not; a; statement",
            "/* a; comment */ SELECT 1;",
            "SELECT 1 /* outer /* inner ; */ still open ; */ ;",
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;",
            "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
        ];
        for sql in cases {
            assert_eq!(statements(sql).len(), 1, "{sql}");
        }
    }

    /// `''` is one quote. Reading it as the end of the string leaves the rest
    /// of the row outside any quote, where its commas and semicolons are
    /// suddenly syntax.
    #[test]
    fn a_doubled_quote_stays_inside_the_string() {
        let out = statements("INSERT INTO t VALUES ('it''s; fine', 2);");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, Kind::Insert);
    }

    /// A backslash escapes only in `E'…'`. Treating a plain string as if it
    /// escaped is how `'C:\'` swallows the quote that closes it.
    #[test]
    fn a_backslash_escapes_only_in_an_escape_string() {
        assert_eq!(statements("INSERT INTO t VALUES ('C:\\'); SELECT 1;").len(), 2);
        assert_eq!(statements("INSERT INTO t VALUES (E'C:\\\\'); SELECT 1;").len(), 2);
    }

    /// `$1` is a parameter, not a delimiter. Reading it as one puts the rest of
    /// the file inside a string that never closes.
    #[test]
    fn a_parameter_placeholder_is_not_a_dollar_quote() {
        let out = statements("PREPARE p AS SELECT $1; SELECT 2;");
        assert_eq!(out.len(), 2);
    }

    /// pg_dump's entire data section. The rows are not SQL and must never be
    /// handed back as statements.
    #[test]
    fn a_copy_block_is_data_and_not_statements() {
        let sql = "COPY public.users (id, name) FROM stdin;\n\
                   1\tada;lovelace\n\
                   2\tgrace\n\
                   \\.\n\
                   SELECT 1;\n";
        let out = statements(sql);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, Kind::Copy);
        assert!(out[0].copy_data);
        assert_eq!(out[0].target.as_deref(), Some("public.users"));
        assert_eq!(out[1].kind, Kind::Other);
    }

    /// A value that begins with a backslash is ordinary data. Only a line that
    /// is exactly `\.` ends the block.
    #[test]
    fn only_a_lone_terminator_ends_a_copy_block() {
        let sql = "COPY t (a) FROM stdin;\n\\N\n\\\\x\n\\.\nSELECT 1;\n";
        let mut script = Script::new(std::io::Cursor::new(sql.as_bytes().to_vec()));
        let first = script.next_statement().unwrap().unwrap();
        assert!(first.copy_data);
        assert_eq!(script.skip_copy_data().unwrap(), 2);
        assert_eq!(script.next_statement().unwrap().unwrap().kind, Kind::Other);
    }

    /// psql runs a last statement with no terminator. A file that ends mid-line
    /// is also how a truncated download presents, and losing it silently is
    /// worse than the server refusing it.
    #[test]
    fn a_missing_final_terminator_still_yields_the_statement() {
        let out = statements("SELECT 1;\nSELECT 2");
        assert_eq!(out.len(), 2);
    }

    /// Comments between statements are not statements. Counting them would put
    /// a number in the dialog that no other tool agrees with.
    #[test]
    fn comments_alone_are_not_a_statement() {
        assert_eq!(statements("-- header\n\n/* more */\n").len(), 0);
        assert_eq!(statements("-- header\nSELECT 1;").len(), 1);
    }

    /// The line number is what someone opens the file to. It has to be where
    /// the statement began, not where it ended.
    #[test]
    fn the_line_number_is_where_the_statement_started() {
        let out = statements("SELECT 1;\n\n-- note\nINSERT INTO t\n  VALUES (1);\n");
        assert_eq!(out[0].line, 1);
        assert_eq!(out[1].line, 4);
    }

    #[test]
    fn the_relation_is_read_through_its_quoting() {
        let out = statements(
            "INSERT INTO \"public\".\"Order\" VALUES (1);\n\
             CREATE TABLE IF NOT EXISTS public.users (id int);\n\
             COPY \"x\" FROM stdin;\n\\.\n",
        );
        assert_eq!(out[0].target.as_deref(), Some("public.Order"));
        assert_eq!(out[1].target.as_deref(), Some("public.users"));
        assert_eq!(out[2].target.as_deref(), Some("x"));
    }

    /// Every one of these stops a restore on a server that never had the role.
    #[test]
    fn statements_that_name_a_role_are_recognised() {
        let sql = "ALTER TABLE public.users OWNER TO shop_app;\n\
                   GRANT SELECT ON public.users TO readonly;\n\
                   REVOKE ALL ON SCHEMA public FROM PUBLIC;\n\
                   SET SESSION AUTHORIZATION 'shop_app';\n\
                   COMMENT ON EXTENSION plpgsql IS 'x';\n\
                   CREATE TABLE t (id int);\n\
                   SET standard_conforming_strings = on;\n";
        let out = statements(sql);
        let flags: Vec<bool> = out.iter().map(|s| s.ownership).collect();
        assert_eq!(flags, vec![true, true, true, true, true, false, false]);
    }

    /// A statement split across lines keeps its own text, terminator included,
    /// because that text is what goes back to the server.
    #[test]
    fn the_statement_text_is_what_the_file_said() {
        let out = statements("INSERT INTO t\n  VALUES\n  (1);\n");
        assert_eq!(out[0].text.trim(), "INSERT INTO t\n  VALUES\n  (1);");
    }

    /// A file this application's own safe export wrote carries `BEGIN;` and
    /// `COMMIT;`. Run inside an importer's transaction, that `COMMIT` ends the
    /// importer's transaction and everything after it applies outside one — so
    /// the two have to be tellable apart from ordinary statements.
    #[test]
    fn transaction_control_is_its_own_kind() {
        let sql = "BEGIN;\n\
                   INSERT INTO t VALUES (1);\n\
                   SAVEPOINT s;\n\
                   RELEASE SAVEPOINT s;\n\
                   COMMIT;\n";
        let kinds: Vec<Kind> = statements(sql).into_iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                Kind::Transaction,
                Kind::Insert,
                Kind::Transaction,
                Kind::Transaction,
                Kind::Transaction,
            ]
        );
    }

    /// plpgsql's `END` closes a block, not a transaction, and it only ever
    /// appears inside a body this never looks into.
    #[test]
    fn an_end_inside_a_function_body_is_not_transaction_control() {
        let out = statements(
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, Kind::Create);
    }

    #[test]
    fn a_name_is_matched_without_its_schema_or_its_case() {
        assert!(relation_is(Some("public._prisma_migrations"), "_prisma_migrations"));
        assert!(relation_is(Some("_Prisma_Migrations"), "_prisma_migrations"));
        assert!(!relation_is(Some("public.migrations_log"), "migrations"));
        assert!(!relation_is(None, "migrations"));
    }

    #[test]
    fn a_schema_is_read_off_a_qualified_name() {
        assert_eq!(schema_of("public.users"), Some("public"));
        // A bare name is whatever `search_path` says, which this cannot know.
        assert_eq!(schema_of("users"), None);
    }
}
