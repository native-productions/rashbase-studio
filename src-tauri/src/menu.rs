//! The native menu bar.
//!
//! Built from `Menu::default`, with our own entries inserted, rather than
//! assembled item by item: the default is where About, Services, Hide, the
//! whole Edit menu and the window controls come from, and rebuilding those by
//! hand only creates ways to get a standard menu subtly wrong.
//!
//! Menu items carry the id of a command in the frontend's registry and do
//! nothing else. That is what keeps this file from growing a second copy of
//! what every command does: the menu, the palette and the keyboard layer all
//! reach the same `runCommand`, so a command can only behave one way.
//!
//! macOS only, because `Menu::default` only builds a View submenu there. On
//! every other platform the command palette is the way in — which is where the
//! menu sends you anyway.

use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem};
use tauri::{App, Emitter};

/// Carries the id of the command the user picked.
pub const MENU_EVENT: &str = "menu://command";

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;

    // macOS puts Settings in the app menu, under About and a separator, on
    // Cmd+comma. The palette prints the same shortcut, so the two never
    // disagree about what it is.
    let settings = MenuItemBuilder::with_id("settings.open", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let diagram = MenuItemBuilder::with_id("view.diagram", "Show Diagram")
        // ⌘D is free here, and the palette prints the same shortcut, so the
        // two never disagree about what it is.
        .accelerator("CmdOrCtrl+D")
        .build(app)?;

    // The app submenu is the first one and is titled with the app name, which
    // is not a string worth matching on — it comes from the bundle. Position
    // is what identifies it, and it is the one thing about a default macOS
    // menu that is guaranteed.
    let mut placed_settings = false;
    let mut placed_diagram = false;
    for (index, item) in menu.items()?.into_iter().enumerate() {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        if index == 0 && !placed_settings {
            // After "About Rashbase Studio" and its separator, which is where
            // every other macOS app puts it.
            submenu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
            submenu.insert(&settings, 2)?;
            placed_settings = true;
            continue;
        }
        if submenu.text()? != "View" {
            continue;
        }
        // Above Enter Full Screen: what the user came to this menu for is the
        // thing they can only do here, not the thing every window can do.
        submenu.prepend(&diagram)?;
        submenu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        placed_diagram = true;
        break;
    }
    debug_assert!(placed_settings && placed_diagram, "default menu shape changed");

    app.set_menu(menu)?;

    // Predefined items are handled natively and their ids come through here
    // too. They are emitted like any other and the frontend ignores what it
    // does not recognise, which is cheaper than keeping a list of what to skip.
    app.on_menu_event(|app, event| {
        let _ = app.emit(MENU_EVENT, event.id().as_ref());
    });

    Ok(())
}
