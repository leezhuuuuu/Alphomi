# Alphomi Contracts

This package holds protocol references shared across Alphomi's desktop, driver, and brain layers.

## Current Scope

- Port registry schema
- WebSocket event envelope schema
- Tool discovery payload schema

The driver remains the runtime source of truth for browser tool definitions, while these files provide a stable reference point for contributors and tests.

When a protocol changes across Desktop, Driver, or Brain, update these references in the same change.
