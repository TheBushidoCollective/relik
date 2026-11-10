# Completed exact-five maintenance

The one-off maintenance at commit `95f2a3f9f060253985d0f1ee2b5c252bffc24800` targeted five fixed relics covering 17 versions. [Run 42193967133](https://github.com/TheBushidoCollective/relik/actions/runs/42193967133) reports completion and immediate readback for each of the five. It operated on production storage and did not deploy a Cloud Run revision.

The existing operator deletion contract retains the metadata row and tombstone, and blocklisting depends on the deletion reason. This operation used `operator_error` and prohibited blocklist changes. The retained row is not a retained copy of deleted version content.

The historical implementation is preserved on `archie/ephemeral-operator-maintenance`; fake-only proof refs are `archie/ephemeral-operator-proof-4` and `archie/ephemeral-operator-mutations`. Their historical results do not qualify another revision. This operation is complete and must not be replayed. No reusable production maintenance workflow is enabled by this change.
