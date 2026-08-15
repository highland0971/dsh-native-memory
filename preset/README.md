# Why this directory is empty

The plugin ships as a **bundle only** — no agent preset. Memory is a
cross-session capability, so its row belongs in the host composition (the
bundle patch inserts it). Shipping a preset would mean embedding a full copy
of a DSH agent composition here, which rots every time the harness changes
its shipped presets.

## Scoping memory tools to one preset

If a deployment wants the memory tools on some agents only, the host-plane
tool catalog is the same for every session; a preset currently cannot
deselect individual tools declaratively. Two options:

1. Leave the tools visible everywhere and control behavior with config
   (`injectProfile: false` keeps the prompt quiet).
2. Register the same plugin row inside a custom preset instead of the
   bundle (omit the bundle's `insert` entry via a user patch layer). Note
   the plugin then resolves the HOST's storage-domain and approval
   services through `ctx.get` — that works from an agent plane — but the
   FTS enablement patch must still come from a host layer.

Option 2 is documented, not shipped, to avoid preset drift. If you build a
preset variant, generate it from your installed `standard` preset at
development time and note the source revision.
