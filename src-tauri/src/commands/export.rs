//! Writing an export to disk.
//!
//! The split with the driver is deliberate: the driver knows what a dump of
//! these relations should *say*, this file knows where the bytes *go*. That is
//! what lets one dump implementation serve four destinations — a file, a gzipped
//! file, a directory of files, and a tar archive of that directory — without the
//! SQL side knowing any of them exist.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::{
    DbState, DumpWriter, ExportFormat, ExportLayout, ExportRequest, ExportSummary,
};
use crate::error::{Error, Result};

/// Emitted once per relation so the dialog can name what it is on.
///
/// Relation granularity, not row: a row counter ticking past three million is
/// motion, not information, and the user cannot act on it either way.
pub const PROGRESS_EVENT: &str = "export://progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job_id: &'a str,
    table: &'a str,
    done: usize,
    total: usize,
}

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

/// Turns what the user typed into something that cannot leave the chosen folder.
///
/// The folder came from the native picker and is trusted. The name did not.
/// Separators and NUL go, and the leading and trailing dots go with them, which
/// is what stops `..` from being a name at all. The extension is never taken
/// from here; it is decided by the format and the layout below.
fn safe_stem(raw: &str) -> Result<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() {
        return Err(Error::other("Give the export a file name."));
    }
    Ok(cleaned)
}

/// What each relation's own file is called in the per-relation layout.
fn safe_part(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}

fn body_extension(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Sql => "sql",
        ExportFormat::Csv => "csv",
    }
}

/// The name the finished export ends up under, extension included.
///
/// Decided here rather than accepted from the frontend, because a name typed
/// with `.sql` already on it is exactly how a file comes out called
/// `dump.sql.sql.gz`.
pub fn final_name(
    stem: &str,
    format: ExportFormat,
    layout: ExportLayout,
    compress: bool,
) -> String {
    let body = body_extension(format);
    match (layout, compress) {
        (ExportLayout::Single, false) => format!("{stem}.{body}"),
        (ExportLayout::Single, true) => format!("{stem}.{body}.gz"),
        // A directory of loose files, so there is no extension to add.
        (ExportLayout::PerTable, false) => stem.to_string(),
        (ExportLayout::PerTable, true) => format!("{stem}.tar.gz"),
    }
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/// One open output stream.
///
/// An enum rather than `Box<dyn Write>` because gzip has to be *finished*, not
/// merely dropped: the trailer holds the length and the checksum, and a stream
/// that is only dropped produces a file every gzip reader rejects.
enum Sink {
    Plain(BufWriter<File>),
    Gzip(GzEncoder<BufWriter<File>>),
}

impl Sink {
    fn open(path: &Path, compress: bool) -> io::Result<Self> {
        // 64 KiB, so a dump of small rows is a handful of syscalls per megabyte
        // rather than one per row.
        let file = BufWriter::with_capacity(64 * 1024, File::create(path)?);
        Ok(if compress {
            Sink::Gzip(GzEncoder::new(file, Compression::default()))
        } else {
            Sink::Plain(file)
        })
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self {
            Sink::Plain(w) => w.write_all(bytes),
            Sink::Gzip(w) => w.write_all(bytes),
        }
    }

    fn close(self) -> io::Result<()> {
        match self {
            Sink::Plain(mut w) => w.flush(),
            Sink::Gzip(w) => w.finish()?.flush(),
        }
    }
}

/// Where the parts of an export land.
enum Destination {
    /// Everything into one file, opened on the first part and kept.
    One(PathBuf),
    /// A directory holding one file per relation.
    Parts(PathBuf),
}

/// The driver's writer, backed by real files.
///
/// `begin` is the whole difference between the two layouts, which is why the
/// trait has it: in `One` it opens the file once and then does nothing, in
/// `Parts` it closes the relation just written and opens the next.
struct DumpFiles<'a> {
    destination: Destination,
    compress: bool,
    extension: &'static str,
    sink: Option<Sink>,
    app: &'a AppHandle,
    job_id: &'a str,
}

impl DumpFiles<'_> {
    /// Flushes and closes whatever part is open. Errors surface here rather
    /// than at drop, where they would be swallowed.
    fn close_part(&mut self) -> io::Result<()> {
        match self.sink.take() {
            Some(sink) => sink.close(),
            None => Ok(()),
        }
    }
}

impl DumpWriter for DumpFiles<'_> {
    fn begin(&mut self, name: &str) -> io::Result<()> {
        match &self.destination {
            Destination::One(path) => {
                if self.sink.is_none() {
                    self.sink = Some(Sink::open(path, self.compress)?);
                }
                Ok(())
            }
            // Cloned before closing the part, because closing takes `self`
            // mutably and the path is read out of `self.destination`.
            Destination::Parts(dir) => {
                // Never compressed individually: the whole directory becomes one
                // `.tar.gz`, and gzipping members of an archive twice buys
                // nothing but a file nobody can read without two steps.
                let path = dir.join(format!("{}.{}", safe_part(name), self.extension));
                self.close_part()?;
                self.sink = Some(Sink::open(&path, false)?);
                Ok(())
            }
        }
    }

    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        match &mut self.sink {
            Some(sink) => sink.write_all(bytes),
            None => Err(io::Error::other("no output file is open")),
        }
    }

    fn progress(&mut self, table: &str, done: usize, total: usize) {
        // Advisory. A window that has gone away is not a reason to fail an
        // export that is otherwise writing fine.
        let _ = self.app.emit(
            PROGRESS_EVENT,
            Progress {
                job_id: self.job_id,
                table,
                done,
                total,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Dumps the requested relations into the chosen folder.
///
/// `job_id` is made by the caller so Stop has something to name before this
/// call returns. Anything written by an export that fails or is stopped is
/// removed: a half-written dump that looks finished is worse than no dump.
#[tauri::command]
pub async fn export_objects(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
    job_id: String,
    req: ExportRequest,
) -> Result<ExportSummary> {
    let started = std::time::Instant::now();

    let stem = safe_stem(&req.file_name)?;
    let directory = PathBuf::from(&req.directory);
    if !directory.is_dir() {
        return Err(Error::other(format!(
            "{} is not a folder that exists.",
            directory.display()
        )));
    }

    let final_path = directory.join(final_name(&stem, req.format, req.layout, req.compress));
    let per_table = req.layout == ExportLayout::PerTable;

    // Relations are written into a hidden sibling first, so a run that fails
    // halfway never leaves a directory that looks like a finished export.
    let staging = directory.join(format!(".{stem}.part"));
    if per_table {
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;
    }

    let mut files = DumpFiles {
        destination: if per_table {
            Destination::Parts(staging.clone())
        } else {
            Destination::One(final_path.clone())
        },
        compress: req.compress,
        extension: body_extension(req.format),
        sink: None,
        app: &app,
        job_id: &job_id,
    };

    let outcome = db.export(&id, &job_id, &req, &mut files).await;
    // Closed before the result is judged: a gzip stream that was never
    // finished has no trailer, so a "successful" export could otherwise
    // produce a file no reader accepts.
    let closed = files.close_part();

    let discard = || {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&final_path);
    };

    let stats = match (outcome, closed) {
        (Ok(stats), Ok(())) => stats,
        (Err(e), _) => {
            discard();
            return Err(e);
        }
        (Ok(_), Err(e)) => {
            discard();
            return Err(e.into());
        }
    };

    // Archiving a large export is seconds of pure CPU and syscalls, which is
    // the one part of this worth keeping off the async runtime's threads.
    let compress = req.compress;
    let assembled = tokio::task::spawn_blocking({
        let staging = staging.clone();
        let final_path = final_path.clone();
        let stem = stem.clone();
        move || -> Result<()> {
            if !per_table {
                return Ok(());
            }
            if compress {
                archive(&staging, &final_path, &stem)?;
                fs::remove_dir_all(&staging)?;
            } else {
                // Replaced, not merged: the dialog already said a name in use
                // is overwritten, and merging would keep files from an earlier
                // export of a different set of tables.
                let _ = fs::remove_dir_all(&final_path);
                fs::rename(&staging, &final_path)?;
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| Error::other(e.to_string()))?;

    if let Err(e) = assembled {
        discard();
        return Err(e);
    }

    Ok(ExportSummary {
        bytes: size_on_disk(&final_path),
        path: final_path.to_string_lossy().to_string(),
        tables: stats.tables,
        rows: stats.rows,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Whether an export with these settings would replace something.
///
/// The name is composed here rather than in the window so there is one answer
/// to "what will this file be called": the dialog can warn about a collision
/// only if it is asking about the same path the export will actually write.
#[tauri::command]
pub async fn export_target_exists(
    directory: String,
    file_name: String,
    format: ExportFormat,
    layout: ExportLayout,
    compress: bool,
) -> Result<bool> {
    let Ok(stem) = safe_stem(&file_name) else {
        return Ok(false);
    };
    let path = PathBuf::from(directory).join(final_name(&stem, format, layout, compress));
    Ok(path.exists())
}

/// Asks a running export to stop. Silent when it has already finished.
#[tauri::command]
pub async fn cancel_export(db: State<'_, DbState>, job_id: String) -> Result<()> {
    db.cancel_job(&job_id).await;
    Ok(())
}

/// Packs the staged directory into a single gzipped tar.
///
/// Staged first rather than streamed, because a tar entry's header carries its
/// size and the size of a dump is not known until it has been written.
fn archive(staging: &Path, destination: &Path, root: &str) -> Result<()> {
    let file = BufWriter::with_capacity(64 * 1024, File::create(destination)?);
    let encoder = GzEncoder::new(file, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder.append_dir_all(root, staging)?;
    let encoder = builder.into_inner()?;
    encoder.finish()?.flush()?;
    Ok(())
}

/// Bytes the export occupies, whether it is one file or a directory of them.
fn size_on_disk(path: &Path) -> u64 {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => fs::read_dir(path)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.metadata().ok())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one piece of user text that becomes a path. If it can hold a
    /// separator, the folder the user picked stops being where the file lands.
    #[test]
    fn a_typed_name_cannot_leave_the_chosen_folder() {
        assert!(safe_stem("../../etc/passwd").unwrap() == "etcpasswd");
        assert!(safe_stem("a/b\\c").unwrap() == "abc");
        assert!(safe_stem("..").is_err());
        assert!(safe_stem("   ").is_err());
        assert!(safe_stem("").is_err());
        assert_eq!(safe_stem(" shop_2026-08-18 ").unwrap(), "shop_2026-08-18");
    }

    /// A gzip stream that is dropped rather than finished has no trailer, and
    /// every reader rejects it. The bug is invisible until someone tries to
    /// open the export, which is the worst possible time to find out.
    #[test]
    fn a_compressed_file_can_actually_be_read_back() {
        use std::io::Read;

        let path = scratch().join("one.sql.gz");
        let mut sink = Sink::open(&path, true).unwrap();
        sink.write_all(b"CREATE TABLE \"users\" (\n    \"id\" integer\n);\n")
            .unwrap();
        sink.close().unwrap();

        let mut text = String::new();
        flate2::read::GzDecoder::new(File::open(&path).unwrap())
            .read_to_string(&mut text)
            .unwrap();
        assert!(text.starts_with("CREATE TABLE"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The per-relation layout is staged on disk and then packed, so the thing
    /// the user receives is the archive, not the files that made it.
    #[test]
    fn an_archive_holds_every_part_under_one_folder() {
        let root = scratch();
        let staging = root.join(".shop.part");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("public.users.sql"), b"-- users\n").unwrap();
        fs::write(staging.join("public.orders.sql"), b"-- orders\n").unwrap();

        let destination = root.join("shop.tar.gz");
        archive(&staging, &destination, "shop").unwrap();

        let decoder = flate2::read::GzDecoder::new(File::open(&destination).unwrap());
        let mut entries: Vec<String> = tar::Archive::new(decoder)
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().to_string())
            .filter(|p| p.ends_with(".sql"))
            .collect();
        entries.sort();
        assert_eq!(
            entries,
            vec!["shop/public.orders.sql", "shop/public.users.sql"]
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A directory of this run's own, so two tests never share a path.
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rashbase-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn part_names_degrade_rather_than_fail() {
        assert_eq!(safe_part("public.users"), "public.users");
        assert_eq!(safe_part("../etc"), "etc");
        assert_eq!(safe_part("."), "unnamed");
    }

    /// The extension is the backend's to decide, and every cell of this table
    /// is a file the user has to be able to open by double clicking it.
    #[test]
    fn every_destination_gets_the_right_extension() {
        use ExportFormat::{Csv, Sql};
        use ExportLayout::{PerTable, Single};

        assert_eq!(final_name("shop", Sql, Single, false), "shop.sql");
        assert_eq!(final_name("shop", Sql, Single, true), "shop.sql.gz");
        assert_eq!(final_name("shop", Csv, Single, false), "shop.csv");
        assert_eq!(final_name("shop", Csv, Single, true), "shop.csv.gz");
        // A directory has no extension; compressing one produces an archive.
        assert_eq!(final_name("shop", Sql, PerTable, false), "shop");
        assert_eq!(final_name("shop", Sql, PerTable, true), "shop.tar.gz");
        assert_eq!(final_name("shop", Csv, PerTable, true), "shop.tar.gz");
    }
}
