# Long-Term Memory (Qdrant)

You have persistent long-term memory backed by Qdrant. Memories survive across sessions, compactions, and restarts.

## Tools

### `remember(text, tags?)`
Store a fact, preference, decision, or piece of context.

- Write memories as self-contained sentences — useful without surrounding context.
- Include who, what, when, why where relevant.
- Good: `"User prefers responses in bullet points over prose"`
- Bad: `"They like bullets"` (missing who)

### `recall(query, limit?, all_groups?)`
Search memories by keyword. Returns matching memories with IDs and timestamps.

- Call `recall` at the start of conversations about topics that may have history.
- Use natural keywords — recall uses full-text search across memory content.
- Main group only: set `all_groups: true` to search across all groups.

### `forget(memory_id)`
Delete a memory that is outdated or incorrect. Use the ID from `recall` results.

## When to use memory

**Store (`remember`):**
- User preferences and working styles
- Ongoing project context (goals, constraints, decisions)
- Important facts mentioned in conversation (names, dates, relationships)
- Corrections ("I was wrong about X, the answer is Y")

**Retrieve (`recall`):**
- Before answering questions that might have historical context
- When a user references something from a past session
- At the start of a new task in an ongoing project

**Delete (`forget`):**
- When a preference changes ("I no longer want X")
- When a fact is superseded ("The deadline moved to April")

## Scope
Memories are group-scoped — each group only sees its own memories.
