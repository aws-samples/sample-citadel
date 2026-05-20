# Workflow Builder Styling Guide

This document describes the comprehensive styling and theming implementation for the Agent Workflow Builder.

## Overview

The workflow builder uses a consistent dark theme with carefully crafted animations, transitions, and responsive design patterns. All styling follows modern CSS best practices with GPU acceleration, accessibility considerations, and performance optimizations.

## Color Palette

### Primary Colors
- **Background**: `#0a0a0a` - Deep black for canvas
- **Card Background**: `#1a1a1a` - Slightly lighter for components
- **Border**: `#2a2a2a` - Subtle borders
- **Hover Border**: `#3a3a3a` - Interactive state borders

### Accent Colors
- **Primary Blue**: `#3b82f6` - Selected states, connections
- **Success Green**: `#10b981` - Valid states, success messages
- **Error Red**: `#ef4444` - Validation errors, warnings
- **Warning Yellow**: `#f59e0b` - Unsaved changes, warnings

### Text Colors
- **Primary Text**: `#ffffff` - High contrast text
- **Secondary Text**: `#9ca3af` - Muted text
- **Tertiary Text**: `#6b7280` - Subtle text

## Component Styling

### AgentNode
- **Base**: Dark background with subtle border
- **Hover**: Elevated with enhanced shadow
- **Selected**: Blue border with pulsing glow animation
- **Error**: Red border with shake animation
- **Dragging**: Slightly transparent with scale effect

### AgentTrayItem
- **Base**: Card-style with hover lift effect
- **Hover**: Shimmer animation, slight translation
- **Active**: Scale down for tactile feedback
- **Dragging**: Fade and scale animation

### WorkflowCanvas
- **Background**: Deep black with grid pattern
- **Empty State**: Centered with fade-in animation
- **Grid**: Subtle gray dots for spatial reference

### Connection Edges
- **Default**: Gray stroke with smooth curves
- **Hover**: Thicker stroke with color change
- **Selected**: Blue with pulse animation
- **Animated**: Dashed line with flow animation
- **Error**: Red dashed with error animation

### Handles (Connection Points)
- **Default**: Small circles with subtle background
- **Hover**: Scale up with glow effect
- **Connecting**: Pulse animation
- **Valid**: Green glow
- **Invalid**: Red glow

### Toolbar
- **Background**: Semi-transparent with backdrop blur
- **Buttons**: Hover lift with shadow enhancement
- **Badges**: Color-coded status indicators

## Animations

### Node Animations
```css
/* Pulse glow for selected nodes */
@keyframes pulse-glow {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(59, 130, 246, 0.5)); }
  50% { filter: drop-shadow(0 0 16px rgba(59, 130, 246, 0.7)); }
}

/* Drop animation for new nodes */
@keyframes node-drop {
  0% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
}

/* Error shake */
@keyframes error-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
```

### Edge Animations
```css
/* Edge pulse for selected connections */
@keyframes edge-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.6; }
}

/* Flow animation for animated edges */
@keyframes edge-flow {
  to { stroke-dashoffset: -10; }
}
```

### Handle Animations
```css
/* Handle pulse when connecting */
@keyframes handle-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.4); }
}
```

### UI Animations
```css
/* Fade in for empty states */
@keyframes fade-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Skeleton shimmer for loading states */
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

## Responsive Design

### Desktop (> 1024px)
- Full sidebar visible
- All toolbar buttons with labels
- Large minimap
- Standard node sizes

### Tablet (768px - 1024px)
- Sidebar visible but narrower
- Compact toolbar
- Smaller minimap
- Slightly reduced node sizes

### Mobile (< 768px)
- Sidebar hidden by default (can be toggled)
- Icon-only toolbar buttons
- No minimap
- Larger touch targets for handles
- Full-width canvas

## Accessibility Features

### Keyboard Navigation
- Focus indicators on all interactive elements
- Tab order follows logical flow
- Keyboard shortcuts for common actions

### Screen Readers
- ARIA labels on all controls
- Semantic HTML structure
- Descriptive alt text

### High Contrast Mode
- Thicker borders and strokes
- Enhanced color contrast
- Larger touch targets

### Reduced Motion
- Animations disabled when `prefers-reduced-motion` is set
- Static focus indicators
- Instant transitions

## Performance Optimizations

### GPU Acceleration
```css
.react-flow__node,
.react-flow__edge,
.agent-tray-item {
  will-change: transform;
  transform: translateZ(0);
}
```

### Paint Optimization
```css
.react-flow__renderer {
  contain: layout style paint;
}
```

### Smooth Scrolling
```css
.agent-tray-scroll {
  scroll-behavior: smooth;
}
```

## Custom Utility Classes

### Badges
- `.workflow-badge` - Base badge style
- `.workflow-badge-success` - Green success badge
- `.workflow-badge-error` - Red error badge
- `.workflow-badge-warning` - Yellow warning badge
- `.workflow-badge-info` - Blue info badge

### Cards
- `.workflow-card` - Base card with hover effect
- `.workflow-glass` - Glassmorphism effect

### Effects
- `.workflow-neon-blue` - Blue neon glow
- `.workflow-neon-green` - Green neon glow
- `.workflow-neon-red` - Red neon glow

## Browser Support

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support (with -webkit- prefixes)
- Mobile browsers: Optimized touch interactions

## Dark Theme Consistency

All components follow the dark theme palette defined in `custom.css`:
- Background colors use the `--background` CSS variable
- Foreground colors use the `--foreground` CSS variable
- Accent colors use the `--primary` CSS variable
- Border colors use the `--border` CSS variable

## Print Styles

When printing workflows:
- Toolbar and controls are hidden
- Background is white
- Nodes and edges use black for clarity
- Layout is preserved

## Future Enhancements

Potential styling improvements for future iterations:
1. Theme switcher (light/dark/custom)
2. Customizable node colors
3. Connection line styles (straight, curved, step)
4. Zoom-level dependent detail rendering
5. Custom node templates with different layouts
6. Animated background patterns
7. Particle effects for connections
8. 3D transform effects for nodes

## Usage Examples

### Adding a Custom Node Style
```tsx
<div className="workflow-card workflow-neon-blue">
  {/* Node content */}
</div>
```

### Creating a Status Badge
```tsx
<span className="workflow-badge workflow-badge-success">
  Active
</span>
```

### Applying Glassmorphism
```tsx
<div className="workflow-glass p-4 rounded-lg">
  {/* Content */}
</div>
```

## Maintenance Notes

- All animations respect `prefers-reduced-motion`
- Colors are defined as CSS variables for easy theming
- Transitions use consistent timing functions
- Z-index values are managed hierarchically
- All measurements use rem/em for scalability
