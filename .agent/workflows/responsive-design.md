---
description: All new pages must be fully responsive with mobile card views
---

# Responsive Design Requirements

All pages in Zeron CRM MUST be responsive. Follow these mandatory patterns:

## Table-based pages (list views)

1. **Desktop table**: Wrap `<table>` in `<div className="hidden md:block overflow-x-auto w-full">`
2. **Mobile cards**: Add `<div className="md:hidden grid grid-cols-1 gap-4 p-4 bg-gray-50">` with card-based layout
3. **Each mobile card** should use `bg-white p-5 rounded-xl border border-gray-100 shadow-sm`

## Header sections

1. Use `flex flex-col sm:flex-row` for header layouts with title + button
2. Add `gap-4` and `items-start sm:items-center` for proper stacking

## Modals

1. Use `max-h-[90vh] overflow-y-auto` to prevent overflow
2. Use ARCA gradient headers: `bg-gradient-to-r from-blue-600 to-purple-600`

## General rules

- Never use fixed-width containers without `max-w` + responsive variants
- All grids should use `grid-cols-1 sm:grid-cols-2` or similar breakpoint patterns
- Tables must have `min-w-[...]` with `overflow-x-auto` wrapper
