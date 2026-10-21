---
"@intentface/latch-knowledge": minor
---

New, experimental: `@intentface/latch-knowledge`. Knowledge for agents in your own Postgres, in spaces a principal sees as mounts (`/practices` shared, `/org`, `/me`), reached through file tools (`list_files`, `read_file`, `glob`, `grep`, `search_files`, `write_file`, `edit_file`) checked against grants on every call. Files are marked trusted or reference by who can edit them; writes are compare-and-swap with a version history; `purgeOwner` plugs into `runtime.purgeOwner`'s `also`.
