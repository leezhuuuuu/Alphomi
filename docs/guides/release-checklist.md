# Release Checklist

## Before Tagging

- [ ] `pnpm validate`
- [ ] verify the target packaging command on the release platform
- [ ] confirm the bundled Brain binary is present
- [ ] confirm `config.example.yaml` still matches runtime expectations
- [ ] update `CHANGELOG.md`
- [ ] review contributor-facing docs for setup changes

## Before Publishing

- [ ] confirm app metadata and version numbers
- [ ] confirm signing or notarization steps for the release platform
- [ ] verify installer output or unpacked app output
- [ ] note any known limitations in release notes

## After Publishing

- [ ] attach artifacts
- [ ] publish release notes
- [ ] link upgrade or migration notes if needed
