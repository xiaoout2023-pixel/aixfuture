***

name: AIX Future Vision
colors:
surface: '#131313'
surface-dim: '#131313'
surface-bright: '#3a3939'
surface-container-lowest: '#0e0e0e'
surface-container-low: '#1c1b1b'
surface-container: '#201f1f'
surface-container-high: '#2a2a2a'
surface-container-highest: '#353534'
on-surface: '#e5e2e1'
on-surface-variant: '#b9cbbd'
inverse-surface: '#e5e2e1'
inverse-on-surface: '#313030'
outline: '#849588'
outline-variant: '#3a4a3f'
surface-tint: '#00e290'
primary: '#f5fff5'
on-primary: '#003920'
primary-container: '#00ffa3'
on-primary-container: '#007146'
inverse-primary: '#006d43'
secondary: '#adc6ff'
on-secondary: '#002e6a'
secondary-container: '#0566d9'
on-secondary-container: '#e6ecff'
tertiary: '#fcfcfc'
on-tertiary: '#2f3131'
tertiary-container: '#e0e0e0'
on-tertiary-container: '#616363'
error: '#ffb4ab'
on-error: '#690005'
error-container: '#93000a'
on-error-container: '#ffdad6'
primary-fixed: '#52ffac'
primary-fixed-dim: '#00e290'
on-primary-fixed: '#002111'
on-primary-fixed-variant: '#005231'
secondary-fixed: '#d8e2ff'
secondary-fixed-dim: '#adc6ff'
on-secondary-fixed: '#001a42'
on-secondary-fixed-variant: '#004395'
tertiary-fixed: '#e2e2e2'
tertiary-fixed-dim: '#c6c6c7'
on-tertiary-fixed: '#1a1c1c'
on-tertiary-fixed-variant: '#454747'
background: '#131313'
on-background: '#e5e2e1'
surface-variant: '#353534'
typography:
display-lg:
fontFamily: Space Grotesk
fontSize: 64px
fontWeight: '700'
lineHeight: '1.1'
letterSpacing: -0.04em
headline-xl:
fontFamily: Space Grotesk
fontSize: 40px
fontWeight: '600'
lineHeight: '1.2'
letterSpacing: -0.02em
headline-md:
fontFamily: Space Grotesk
fontSize: 24px
fontWeight: '500'
lineHeight: '1.4'
letterSpacing: -0.01em
body-lg:
fontFamily: Inter
fontSize: 18px
fontWeight: '400'
lineHeight: '1.6'
letterSpacing: '0'
body-md:
fontFamily: Inter
fontSize: 15px
fontWeight: '400'
lineHeight: '1.6'
letterSpacing: '0'
label-sm:
fontFamily: Inter
fontSize: 12px
fontWeight: '600'
lineHeight: '1'
letterSpacing: 0.05em
rounded:
sm: 0.25rem
DEFAULT: 0.5rem
md: 0.75rem
lg: 1rem
xl: 1.5rem
full: 9999px
spacing:
unit: 4px
xs: 4px
sm: 8px
md: 16px
lg: 24px
xl: 40px
xxl: 80px
container-max: 1200px
gutter: 24px
------------

## Brand & Style

The design system is engineered for a high-end AI research and community platform. It targets a sophisticated audience of developers, creators, and tech enthusiasts. The aesthetic is a fusion of **Minimalism** and **Modern Tech**, drawing heavy inspiration from the Framer interface—characterized by precision, high-quality depth, and purposeful whitespace.

The emotional response should be one of "quiet power": a professional, dark-themed environment that feels futuristic yet grounded. Visual interest is achieved not through clutter, but through exquisite micro-interactions, subtle glassmorphism, and a disciplined use of vibrant accent colors against a deep obsidian backdrop.

## Colors

The palette is anchored in a "True Dark" philosophy. The primary background uses a near-black obsidian to allow content to breathe and highlights to pop.

- **Primary (#00FFA3):** An electric, "Neo-Mint" green used sparingly for key call-to-actions, success states, and indicating active AI processes.
- **Secondary (#3B82F6):** A technical blue utilized for secondary interactions, links, and informational accents.
- **Neutral/Surface:** We employ a tiered grayscale system. Surfaces are elevated using subtle shifts in hex values rather than heavy borders, creating a sense of physical layering.
- **Accents:** High-contrast white is reserved for primary typography to ensure maximum legibility against the dark canvas.

## Typography

This design system utilizes a dual-font strategy to balance character with utility.

**Space Grotesk** is the voice of the brand, used for headlines and display text. Its geometric quirks and technical feel reinforce the "Future Vision" narrative.

**Inter** is the functional workhorse for all body copy, inputs, and UI labels. It provides the neutral, high-legibility foundation required for a content-rich community platform. We emphasize tight tracking for large headlines and generous leading for body text to maintain a premium, editorial feel.

## Layout & Spacing

The layout follows a **Fixed Grid** model for desktop, centered within the viewport to maintain focus and a high-end "boutique" feel. We utilize a 12-column grid system with generous gutters.

The spacing rhythm is based on a 4px baseline, ensuring all elements align to a mathematical scale. Negative space is treated as a first-class citizen—layout sections are separated by significant vertical padding (XXL) to prevent visual fatigue and highlight the community's premium content.

## Elevation & Depth

Depth is achieved through **Tonal Layers** and **Subtle Blooms**. Rather than traditional heavy drop shadows, we use:

1. **Inner Borders:** 1px solid borders at low opacity (White @ 10%) on containers to simulate a "beveled glass" edge.
2. **Surface Tiers:** Background levels elevate from `#050505` (Base) to `#121212` (Cards) to `#1A1A1A` (Floating menus).
3. **Soft Glows:** Primary buttons and active states feature a very soft, diffused outer glow (blur radius 20px+) using the primary green or secondary blue at 20% opacity.
4. **Glassmorphism:** Navigation bars and context menus use a backdrop-filter blur (20px) with a semi-transparent surface to maintain context of the underlying content.

## Shapes

The design system employs a **Rounded** shape language to soften the "tech" edge and make the UI feel more approachable.

- **Standard Elements (Buttons, Inputs):** 0.5rem (8px) radius.
- **Cards and Containers:** 1rem (16px) radius to create a distinct framing for content.
- **Interactive Tags:** 1.5rem (24px) or full pill-shape for high-contrast visibility.

## Components

### Buttons

- **Primary:** Solid `#00FFA3` background with `#0A0A0A` text. High-gloss finish with a subtle top-light inner shadow.
- **Secondary:** Ghost style with a 1px `#FFFFFF` (20% opacity) border. White text. Transitions to a solid white background on hover.

### Cards

- Surfaces use `#121212` with a subtle 1px border.
- Hover states should trigger a slight lift (Y-axis translation) and an increase in border opacity or a subtle primary-colored "bloom" shadow.

### Input Fields

- Dark, recessed appearance using `#050505`.
- Focus state triggers a 1px border of `#3B82F6` and a soft blue outer glow.

### Chips & Tags

- Used for AI categories or community tags. Small, uppercase text with a pill-shaped container. Backgrounds should be low-saturation versions of the brand colors (e.g., Blue at 10% opacity).

### Additional Components

- **Code Blocks:** Deep black background with syntax highlighting that mirrors the system's primary/secondary/tertiary colors.
- **Activity Feed:** Minimalist vertical lines connecting timestamped events, utilizing the secondary blue for the line-work.

