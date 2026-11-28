# Fork hardening, November 2026

This fork preserves skill evolution and adds two fixes on top of revision 379180435375fa6d895973a927b8222a82a9cb68:

- Edited tool results retain their source-backed call ID, tool name and error status, even when blocks are reordered. New model-authored notes cannot acquire a call ID by position. Rewritten results carry `details.clmEdited=true`.
- Session startup awaits required-child-extension registration. Disposal invalidates in-flight resolution; a new session replaces the previous registration, and stale asynchronous work cannot overwrite it.

This revision also fixes the v1 adversarial-review blockers: mirror publication is predicated on the draft's stored generation and rechecks its lease before the visible rename; a changed tree/ledger after an awaited commit fails closed to the verified ledger and rewrites the mirror; `/clm commit` and the tool share one accepted-file digest check; a headerless rewrite requires an explicit current-revision declaration and reason, and owner turns cannot be demoted; duplicate tool-call IDs inside one assistant group are terminalized; and overflow notices are bounded.

Validation: TypeScript typecheck and all 284 tests pass, including focused publication/lease, command digest, rewrite-gate, role-demotion, duplicate-ID and overflow-notice cases. Synthetic installed-Pi startup checks CLM, public pi-subagents 0.80.0 and goals together without sending inference requests. The public registry API was exercised directly.

Temporary-note privacy in the optional evolution CLI remains deliberately deferred by the operator; see https://github.com/shadowndacorner/pi-clm/issues/1. This feature has not been disabled or removed. Use trusted tasks: evolution scripts run with the caller's normal host permissions and environment. The source review does not certify a sandbox or absence of all vulnerabilities.
