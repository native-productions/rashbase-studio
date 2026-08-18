# Rashbase Studio

register: product

## Product purpose

A free, AI-native database client for macOS, Windows, and Linux.

TablePlus has the flow and the polish but charges for it. Beekeeper Studio is
open source but interrupts work with upsells. Neither treats AI as part of the
foundation: it sits in a sidebar, disconnected from the schema the user is
actually working against.

Rashbase Studio matches TablePlus on keyboard density and craft, costs nothing,
and reasons about the connected schema as a first-class capability rather than a
bolted-on panel.

## Users

One developer, working alone or on a small team, who lives in a database client
for hours a day. They know SQL. They do not need hand-holding, they need the
tool to disappear: keyboard reachable, instant to respond, honest about what it
is about to do to their data.

They are as likely to be inspecting a local Docker Postgres as a production
replica, often in the same session. Telling those two apart at a glance is a
safety feature, not a nicety.

## Tone

Direct and quiet. The interface states facts (row counts, timings, error codes)
and otherwise stays out of the way. No celebration, no encouragement, no
personality in the chrome. The data is the content; everything else is framing.

Error messages carry the database's own words plus the position it blamed. They
never soften or paraphrase what Postgres said.

## Anti-references

- **Dashboard-style DB tools** that wrap every panel in a card with a drop
  shadow. A result grid is a dense scan surface, not a collection of widgets.
- **Neon-on-black developer tools.** High contrast at moderate ambient light is
  fatiguing across an eight-hour session.
- **Upsell interruptions of any kind.** No banners, no trial counters, no
  feature gates.
- **AI as a chat sidebar.** A chat window that cannot see the schema is a worse
  version of a browser tab.

## Principles

1. **The grid is the product.** Every other surface recedes so the data is the
   brightest thing on screen.
2. **Keyboard first.** Anything done more than a few times a day has a binding,
   and that binding is registered exactly once so the palette can never
   advertise a shortcut that does not work.
3. **Frequency decides motion.** Actions repeated hundreds of times a day are
   instant. Animation is reserved for surfaces the user meets occasionally.
4. **Never guess at destructive intent.** Generated writes are shown before they
   run. AI-authored statements are always approved by a human first, without
   exception, and never auto-executed.
5. **Credentials belong to the OS.** Passwords live in the platform keystore and
   never travel back to the webview.
6. **Honest performance.** A threshold that cannot be measured is not claimed to
   be met.
