# ADR-0002: Ship the Brain Service as a Bundled Binary in Desktop Releases

## Status
Accepted

## Context

End users should not need to install Python to use Alphomi. Contributors may still use Python tooling locally, but release builds should behave like a normal desktop product.

The current product already works as a local multi-process desktop system. The main packaging choice is whether Brain remains a source-time dependency only or becomes a bundled runtime artifact.

## Decision

Bundle the Brain service as a compiled binary in desktop release artifacts while keeping source-based development available in the repository.

## Consequences

### Positive

- End users install one desktop product
- Release behavior is closer to a conventional app
- Python remains an implementation detail in distributed builds

### Negative

- Packaging scripts need to build and stage the binary reliably
- Cross-platform release CI becomes more important

### Neutral

- Contributors still need Python for source development
- Debugging release issues may require inspecting both source and binary paths

## Alternatives Considered

**Require Python at runtime**
- Rejected because it raises friction for end users

**Rewrite Brain into the desktop process**
- Rejected because it would trade packaging simplicity for architecture churn

## References

- `scripts/build-brain.sh`
- `package.json`
