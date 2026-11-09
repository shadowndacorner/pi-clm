# Fork hardening, November 2026

This fork preserves skill evolution and adds two fixes to blackcandlelabs revision 379180435375fa6d895973a927b8222a82a9cb68:

- Edited tool results retain their source-backed call ID, tool name and error status, even when blocks are reordered. New model-authored notes cannot acquire a call ID by position. Rewritten results carry `details.clmEdited=true`.
- Session startup awaits required-child-extension registration. Disposal invalidates in-flight resolution; a new session replaces the previous registration, and stale asynchronous work cannot overwrite it.

Validation: TypeScript typecheck and all 230 tests pass, including seven new source-identity and registration-race cases. Synthetic installed-Pi startup checks CLM, public pi-subagents 0.80.0 and goals together without sending inference requests. The public registry API was exercised directly.

Temporary-note privacy in the optional evolution CLI remains deliberately deferred by the operator; see https://github.com/shadowndacorner/pi-clm/issues/1. This feature has not been disabled or removed. Use trusted tasks: evolution scripts run with the caller's normal host permissions and environment. The source review does not certify a sandbox or absence of all vulnerabilities.
