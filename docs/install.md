# Install

Requires DeepSeek Harness 0.1.0-rc.x with the `web` profile (the memory unit
rides the host storage-domain facility with the JSON backend).

## From this repo (development / pre-release)

```sh
dsh plugin --profile web add /path/to/dsh-native-memory
# or a git spec:
dsh plugin --profile web add github:dsh-native-memory/dsh-native-memory
```

## From npm (after release)

```sh
dsh plugin --profile web add dsh-native-memory
```

Then restart `dsh web` and open any session. The bundle patch:

1. inserts the `dsh-native-memory` row into the host composition, and
2. enables session-query full-text search (`openAt: first-search`, durable
   index at `~/.dsh/storages/session-search.sqlite`).

## Configuration

Any field can be overridden in your profile patch
(`~/.dsh/profiles/web/cordis.patch.yml`), which always applies last:

```yaml
- id: dsh-native-memory
  config:
    injectProfile: false   # drop the always-on profile section
    approvalWrites: true   # keep the write approval gate
    maxFactsPerWorkspace: 300
```

## Verification

```text
1. New session in a workspace → tools list shows memory_remember,
   memory_recall, memory_search, memory_edit, memory_forget, memory_profile.
2. "remember that this project uses pnpm" → approve in the UI → fact lands.
3. Second session, same workspace → memory_recall returns the fact; the
   profile section appears in the prompt.
4. A session in another workspace → memory_recall returns nothing.
5. ~/.dsh/storages/dsh_memory.json exists and holds the fact.
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-native-memory
```

The memory unit file and the search index are user data and are left in
place; delete them manually if you want them gone.
