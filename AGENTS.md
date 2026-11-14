# Frontend design

- Use IBM Carbon as the primary component system. Read `.agents/skills/carbon-builder/SKILL.md` for Carbon work; consult official Carbon documentation and installed source when Carbon MCP is unavailable. Do not claim MCP verification without running it.
- Taste Skill is installed at `.agents/skills/design-taste-frontend/SKILL.md`. Apply it to marketing pages; for this operational attendance app, Carbon conventions and the rules below take priority over Taste's marketing heroes, animation, photographs and full-screen sections.
- The user chose green as the primary brand with very little red: white/light gray surfaces, pale green selection, darker green actions with readable contrast. Reserve red for errors, danger and small accents; avoid large red surfaces.
- Reuse existing components, Carbon tokens, spacing, typography scale and accessible controls. Do not add a second component library.
- Define typography through Carbon type-style mixins in `frontend/src/carbon.scss`, using the user-selected Inter font hosted locally and weights 400/600. Do not reintroduce fractional font sizes or per-component font-family stacks in `App.css`.
- Use concise Vietnamese for new UI. Keep navigation functional; do not invent employee counts, backend status, reports or settings.
- Preserve camera lifecycle, recognition, consent, validation and backend error handling during visual changes.
- Verify build/lint, desktop/mobile layout, keyboard navigation and affected attendance/enrollment flows. Report checks that could not run.
