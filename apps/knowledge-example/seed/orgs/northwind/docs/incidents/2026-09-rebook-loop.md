# Incident: shipment rebooked three times (2026-09-17)

Shipment NW-3982 was rebooked three times in four hours. Each rebooking was
under the €500 auto-approve threshold, so no dispatcher saw them. The shipper
received three different arrival times.

Cause: the agent treated its own rebooking's new delay estimate as a new delay.

Fix: no auto-approval for rebookings (see the rebooking playbook), and a
24-hour lock per shipment.
