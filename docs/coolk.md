# `coolK`: which thickness is it written for?

`docs/ASSESSMENT.md` closed with one question for a moulding engineer, and it
has blocked cycle time — and every cost derived from it — ever since:

> whether the cooling-time coefficient in the material table is written for
> half-wall or full-wall thickness. The two conventions differ by a factor of
> four in the resulting cycle time, so cycle time and the cost model that would
> sit on top of it both wait on the answer. Whichever number appears on screen
> will be quoted from, which is why no number appears yet.

**It is the full wall.** The comment in `src/core/materials.js` that said
`s = half-wall` was wrong, and is corrected. Nothing else changes: no number
the tool prints today moves, because it has never printed one.

The answer came from re-deriving the coefficient rather than from asking, which
was one of the three routes the roadmap left open. It did not need an engineer
because the arithmetic condemns one of the two readings on its own.

---

## Where the factor of four comes from

One-dimensional transient conduction in a plate of thickness `s`, cooled from
both faces held at the mould temperature, starting uniform at the melt
temperature. Separating variables gives a series whose first term dominates
within a few percent after the first moments, and for the centre plane:

```
(T_centre − T_mould) / (T_melt − T_mould)  ≈  (4/π) · exp(−π²·α·t / s²)
```

Solve for the moment the centre reaches the ejection temperature:

```
t  =  (s² / (π²·α)) · ln[ (4/π) · (T_melt − T_mould) / (T_eject − T_mould) ]
```

`s` here is the **full** wall. The half-thickness `a = s/2` is what appears in
the underlying Fourier number, and it enters as `π²·α·t / (4a²)` — so the same
physics written in terms of the half-wall carries a factor of four, and a
coefficient written as `t = k·a²` is four times one written as `t = k·s²`.

That is the entire ambiguity. Both forms are correct; they are not
interchangeable, and neither the table nor its comment recorded which was meant.

*(A second convention exists inside the same formula: `4/π ≈ 1.273` gives the
moment the centre plane reaches the ejection temperature, `8/π² ≈ 0.811` the
moment the section average does. That one changes the answer by ten to twenty
percent, not by four, and does not affect anything below.)*

## The test

Rearranged, each tabulated coefficient implies a thermal diffusivity:

```
α = ln[ (4/π) · (T_melt − T_mould) / (T_eject − T_mould) ] / (π² · k)
```

under the full-wall reading, and a quarter of that under the half-wall reading.
Thermal diffusivity is a measured property with a well-known range for unfilled
thermoplastics — roughly **0.05 to 0.20 mm²/s**. So the two readings can simply
be checked against physics. Mould and ejection temperatures per family are
assumptions, stated in the test that computes this and varied below.

| material | `coolK` | α if full-wall | α if half-wall |
|---|---|---|---|
| ABS | 1.7 | 0.107 ✓ | 0.027 ✗ |
| Polypropylene | 1.0 | 0.160 ✓ | 0.040 ✗ |
| Polycarbonate | 2.2 | 0.088 ✓ | 0.022 ✗ |
| Nylon 6 | 1.5 | 0.114 ✓ | 0.029 ✗ |
| PA66-GF30 | 1.5 | 0.096 ✓ | 0.024 ✗ |
| Acetal (POM) | 1.4 | 0.115 ✓ | 0.029 ✗ |
| HDPE | 1.1 | 0.166 ✓ | 0.041 ✗ |
| PE | 1.1 | 0.168 ✓ | 0.042 ✗ |
| Polystyrene | 1.5 | 0.118 ✓ | 0.029 ✗ |
| PBT | 1.5 | 0.099 ✓ | 0.025 ✗ |
| PETG | 1.7 | 0.103 ✓ | 0.026 ✗ |
| Acrylic | 2.0 | 0.106 ✓ | 0.027 ✗ |
| TPU | 1.6 | 0.117 ✓ | 0.029 ✗ |
| ASA | 1.8 | 0.103 ✓ | 0.026 ✗ |
| ASA natural | 1.8 | 0.103 ✓ | 0.026 ✗ |
| PC/ASA | 1.9 | 0.102 ✓ | 0.025 ✗ |

**Sixteen of sixteen under the full-wall reading. None under the half-wall
reading.** Every half-wall value is three to seven times below the lowest
diffusivity any thermoplastic has.

The full-wall column is not merely inside the range, it is *ordered correctly*:
the polyolefins come out highest, the glass-filled and the polycarbonates
lowest. A table built on the other convention would have no reason to land that
way.

## How wrong the assumptions would have to be

The mould and ejection temperatures are mine, so the conclusion is only worth
as much as its sensitivity to them.

For ABS to be half-wall *and* physical — α ≥ 0.05 mm²/s — the log term would
have to fall to 0.84 or below. With a 50 °C mould and a 240 °C melt that means
ejecting the part at **155 °C or hotter**: 57 °C above its own heat-deflection
temperature, so it would leave the tool as a soft shape rather than a part.

Sweeping every plausible combination instead of one — mould 20–80 °C, ejection
70–110 °C — the full-wall reading gives α between 0.068 and 0.127 mm²/s, and
the half-wall reading between 0.017 and 0.032. The bands do not overlap, and
only one of them contains a real material.

## What this does not settle

**It answers the convention, not the calibration.** Two things stay open, and
both were already flagged.

The first is the one `docs/ASSESSMENT.md` raised: the formula gives the
*theoretical cooling floor* — the moment the centre plane first reaches
ejection temperature, with the mould wall held at a fixed temperature and heat
leaving in one dimension. A real cycle is longer: the tool's own thermal
response, non-uniform wall, a margin so the part does not distort on the pins.
Practice is commonly 1.5–2× the floor. So a printed cycle time still needs a
decision about which of those two numbers it is, and to say so on screen. On a
2 mm ABS wall this is 6.8 s against something nearer 10–14 s.

The second is new, and it falls out of the table above. The polyolefins imply
the highest diffusivities in the set — PP 0.160, HDPE 0.166, PE 0.168 — where
a semi-crystalline's *effective* diffusivity during cooling should sit at the
**low** end, because the latent heat of crystallisation has to be removed
before the part is rigid. Both readings of the convention share this, so it
does not affect the answer above; but it does suggest `coolK` for PP, PE and
HDPE is optimistic, and that a cycle time quoted for a polyolefin would be the
first to be argued with. Worth a datasheet check before any of these numbers
reach a quotation.

## Keeping it answered

`test/unit.mjs` asserts the convention rather than leaving it in prose: every
material's `coolK` must imply a physically possible diffusivity under the
full-wall reading, and an impossible one under the half-wall reading. An edit
that rewrites a coefficient into the other convention fails there.

---

## A note for whoever adds Vicat

The process assumptions above — mould and ejection temperature per family —
live in `test/unit.mjs`, next to the assertion that uses them, because nothing
in the tool needs them: `coolK` is tabulated and the derivation exists to
check it, not to compute with it. If a later change wants thermal diffusivity
as a quantity in its own right rather than as a check on this one, it should
be a measured column with its own citations, not a value inverted out of
`coolK` through a second set of assumptions. Two assumptions deep is where a
derived number stops being better than no number.

That applies directly to `ts_thermal`, which is the check waiting on a
softening point. The temperature the substrate skin actually reaches at the
interface is derivable — two semi-infinite bodies in contact settle at a
temperature weighted by their thermal penetration coefficients — and it would
be a more honest thing to print than melt against HDT. But it needs α per
material, and inverting α out of `coolK` would hang it off the assumptions
above. Vicat is the shorter route to the same answer, and it is a number
someone can look up.
