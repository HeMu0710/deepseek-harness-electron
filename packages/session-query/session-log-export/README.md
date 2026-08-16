# @deepseek-ai/dsh-session-log-export

English | [中文](README.zh.md)

GUI Session-log download control over the Host-streamed ZIP endpoint owned by `dsh-host-apiproxy`. The Host half registers `/export`; the Client half owns a 111×32 `Session log` action in the Session Header, one download controller, and one modal shared by that button and the slash command. ZIP generation, raw JSONL/zstd reads, descendants, attachments, backpressure, and error semantics remain owned by the [ApiProxy download implementation](../../host/apiproxy/README.md).

## Command contract

| Input | Result |
|---|---|
| `/export` | Record a human-command lifecycle; the submitting GUI receives the local execution acknowledgment and downloads `GET /api/session.export?sessionId=<id>&includeDescendants=true`. |
| `/export <path>` | Return an error. The browser download manager or desktop save dialog chooses the destination. |

The command is mounted by the shared GUI bundle. The local `command/executed` acknowledgment triggers the slash download only after a successful `/export` result in the Client that submitted it; other Clients still render the durable command row without repeating the local side effect. The Header button calls the same controller directly. In a browser, both entry paths issue a `HEAD` preflight and hand the GET URL to the download manager without buffering the ZIP in JavaScript. On desktop, they invoke the isolated preload save operation; the main process obtains an OS-approved path and the utility Host streams the GET body to a temporary file before renaming it into place. Both carriers share in-flight collapsing, preparation-error handling, and the same Modal.

The Host download endpoint flushes a live root Session before `readRaw`, so a slash-triggered ZIP includes the `command/run` and `command/done` pair whose acknowledgment started the download. Cold persisted Sessions require no flush.

The modal reports preparation, download start, or failure. Closing it does not cancel an in-flight download and does not reopen it when that operation later settles. One Session admits one active download at a time; repeated gestures share that operation.

## Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The shared GUI bundle mounts the package beside `dsh-host-apiproxy`, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`. The package contributes its button and modal to the right-aligned `conversation.session.header.utilities` list, independently of the title-adjacent mode, Subagent, and Task entries in `conversation.session.header.actions`; Trajectory carries no export control.

## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser download do not change the derived request prefix.

## Known Limitations and Deferred Work

- The download endpoint requires a persistence backend with a per-Session raw artifact. The shipped JSONL backend supports plaintext and zstd artifacts; SQLite export is not included in this change.
- The selected local path is not returned to Client code. Browser destinations remain owned by the download manager; desktop paths remain inside the trusted main/utility IPC flow.
- In browsers, the preflight reports failures found before ZIP streaming starts; a later descendant or attachment failure is reported by the download manager. Desktop streaming failures return through IPC and appear in the modal.
