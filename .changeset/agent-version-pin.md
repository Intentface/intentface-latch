---
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
---

An agent reference can now pin a CONFIGURATION, not just a scope:

    support          the live config
    org:support      the live config, org scope
    support@7        exactly version 7
    support@draft    the caller's unpublished draft

`parseAgentRef` returns the pin as `at`, and the drizzle store's `resolve`
loads that version or draft instead of the live row.

This is what lets an evaluation measure a configuration without making it live.
The alternative — activating each version in turn to compare them — moves real
traffic between them mid-comparison, so the thing being measured is also the
thing serving users.

Access is unchanged: the live row is still looked up first, so a pin can only
reach configurations of an agent the caller could already resolve, and resolving
a pin never activates anything. A pinned run reports its version on the
telemetry run meta (`configVersion`), which also gives a stored run the version
marker it previously lacked.
