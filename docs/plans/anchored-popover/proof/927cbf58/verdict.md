# A7 rendered review, round 3: anchored comment popovers and version banner

Proof set: proof/927cbf58. Reviewed against mockup.html and spec section 6 A7.

## Verdict: Pass

All core criteria from section 6 A7 and mockup.html are verified:

1. **Attached, target uncovered**:
   - Markdown, code, image, pdf, otio, and audio cards attach to their respective anchors without covering the target.
   - Video at 1440x900 places the composer card below the scrubber track, leaving the picture under review completely clear in both light and dark themes.
   - Flipped video at 390 width positions the composer card above the scrubber when room below is constrained.
   - Mark cards attach directly to the posted marks with the Comments sidebar remaining closed.

2. **Card styling on every class**:
   - Popover card and composer match the document popover across all classes: square geometry, 1px rules, patina primary actions, Charter body font, and monospace target identification.

3. **Video picture clearance**:
   - The card sits below the scrubber (top = scrubber.bottom + 8px), leaving the picture uncovered.

4. **Narrow viewports and capped layout**:
   - At 320px width, field, Post, and Cancel controls remain visible and interactive.
   - The capped layout activates cleanly with data-capped="true", allowing the context to scroll while keeping the field and actions pinned.

5. **Post button contrast**:
   - Measured contrast is 6.06 in light theme and 6.89 in dark theme, satisfying the WCAG 4.5:1 requirement.

6. **Focus rings**:
   - Focus rings on the composer field use the patina token via .popover-field:focus-visible.

7. **Theme matching**:
   - Light and dark themes match across all classes, using consistent token values and surface contrasts.

8. **Version banner truthful states**:
   - The current version stage shows no comparison notice.
   - The earlier version single view displays the truthful class-specific explanation with computed versions, matching mock B4 and B1.
