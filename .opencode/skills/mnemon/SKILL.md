---
name: mnemon
description: Persistent memory CLI for OpenCode. Store facts, recall past knowledge, link related memories, manage lifecycle.
---

# mnemon

## Workflow

1. **Remember**: `mnemon remember "<fact>" --cat <cat> --imp <1-5> --entities "e1,e2" --source agent`
   - Only exact content repeats are skipped; distinct content is stored and diff suggestions are advisory.
   - To retire a superseded memory, store and verify the new fact, then explicitly run `mnemon forget <old-id>`.
   - Output includes `action` (added/skipped), `semantic_candidates`, and `causal_candidates`.
2. **Link** (evaluate candidates from step 1 using judgment):
   - Review `causal_candidates`: link only when the memories are genuinely causally related.
   - Review `semantic_candidates`: high `similarity` alone is not enough; skip unrelated keyword matches.
   - Syntax: `mnemon link <id> <candidate> --type <causal|semantic> --weight <0-1> [--meta '<json>']`
3. **Recall**: `mnemon recall "<query>" --limit 10`

## Recall Intent

Keep focused queries and memories in their original language. When the user's
meaning is clear, choose `--intent WHY` (reasons), `--intent WHEN` (timing),
`--intent ENTITY` (what/who), or `--intent GENERAL` (neutral retrieval).
For example: `mnemon recall "<query>" --intent WHY`. The override works in any
language; `--verbose` reports
`meta.intent` and `meta.intent_source` (`auto` or `override`).

Automatic cues cover some forms in English, Mandarin Chinese (simplified and
traditional), Hindi (Devanagari), Spanish, Modern Standard Arabic, French,
Bengali (Bengali script), Portuguese, Indonesian (Latin script), Russian
(Cyrillic), and German. Unrecognized forms use GENERAL; conflicting cues involving
additional languages also use GENERAL. English/Chinese-only scoring is preserved.
This is a lexical heuristic, not full language understanding. See
[the supported forms, script variants, and limits](https://github.com/mnemon-dev/mnemon/blob/master/docs/USAGE.md#recall-intent-detection).

## Commands

```bash
mnemon remember "<fact>" --cat <cat> --imp <1-5> --entities "e1,e2" --source agent
mnemon link <id1> <id2> --type <type> --weight <0-1> [--meta '<json>']
mnemon recall "<query>" --limit 10
mnemon search "<query>" --limit 10
mnemon import --dry-run <file>
mnemon import <file>
mnemon forget <id>
mnemon related <id> --edge causal
mnemon gc --threshold 0.4
mnemon gc --keep <id>
mnemon status
mnemon log
mnemon store list
mnemon store create <name>
mnemon store set <name>
mnemon store remove <name>
```

## Guardrails

- Use memory only when it can materially improve continuity or task quality.
- Do not store secrets, passwords, tokens, private keys, or short-lived operational noise.
- Categories: `preference`, `decision`, `insight`, `fact`, `context`
- Edge types: `temporal`, `semantic`, `causal`, `entity`
- Max 8,000 chars per insight.
