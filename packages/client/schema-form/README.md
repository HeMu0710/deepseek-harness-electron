# @deepseek-ai/dsh-client-schema-form

English | [中文](README.zh.md)

Schema/draft model layer for settings editors. The wire's `settings.describe` carries each namespace's serialized schemastery schema (`schema.toJSON()` ref envelope); `rehydrateSchema` turns its structural rules back into a live validator with `new Schema(json)`. Serialized transform callbacks become identity transforms instead of executable browser code. The Host remains authoritative for the complete schema when a draft is written. Editors render their own controls (the Models page hand-writes its card around the fields it probes here); this package owns no React and no rendering.

## Contract

The unit of editing is a **draft user section**: a plain object edited immutably (`setPath` materializes intermediates, `deletePath` is the per-field reset — dropping the key falls the resolved value back to the composition base and schema defaults). A field's presence in the draft marks it **overridden** (`hasPath`) — presence semantics, not value comparison, exactly mirroring the settings seam's layering. `nodeAtPath` resolves the schema node addressed by a configurable-provider directory `settingsPath` (object properties by name, dict entries through `inner`), so an editor can probe which fields a provider's profile carries (and their `meta.role`) before deciding what to render; an unresolvable path returns `undefined` so the caller degrades loudly instead of rendering a wrong subtree. `validateDraft(schema, draft)` runs the inert structural validator and returns its failure message, letting pages catch ordinary type and range errors before writing. The settings Host applies the original schema, including transforms and owner validation, before accepting a write.

## Model Experience

None, as this package backs browser configuration editors; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Client validation omits transform behavior** — serialized transform callbacks are executable source, so the renderer replaces them with identity transforms. Client validation can be less strict than the Host for a schema whose callback changes or rejects a value; the authoritative write reports that Host failure.
- **Validation is draft-level, not per-field** — `validateDraft` reports schemastery's first failure message, including its `$.path`; it does not map errors onto individual controls.
- **No generic renderer** — consumers build feature-specific forms over these helpers. The [Web config-plane Agent Note](../../../.agents/notes/implemented/architecture/2026-07-30-web-config-plane.md) records that trade-off.
