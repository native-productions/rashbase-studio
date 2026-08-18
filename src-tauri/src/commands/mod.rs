//! The IPC surface.
//!
//! Split by what each command is about rather than kept as one list: the
//! connection registry touches the filesystem and the keystore, the session
//! commands own the lifecycle, and the query and catalogue commands are thin
//! passes through to the driver. Those are three different sets of concerns
//! and three different reasons to change.
//!
//! Passwords are asymmetric on purpose: they travel *in* once when the user
//! saves a connection, then live in the OS keystore. They never travel back
//! out to the webview, so a compromised renderer cannot read them.

mod catalog;
mod connections;
mod export;
mod query;
mod session;

pub use catalog::*;
pub use connections::*;
pub use export::*;
pub use query::*;
pub use session::*;
