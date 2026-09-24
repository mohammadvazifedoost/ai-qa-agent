# Fixtures

## demo-shop

A small Vite + React + React Router shop used to validate AI QA Agent end to end.
It is intentionally **not** perfect. This file lives outside the fixture's project root so the
AI agent cannot read the answers while it analyzes the app.

### Planted defects (ground truth)

| # | Type | Where | Defect | Expected classification |
|---|------|-------|--------|-------------------------|
| 1 | Functional | `/checkout` | A valid coupon (`SAVE10`, `WELCOME20`) shows "Coupon … applied" and a Discount row, but **Total never changes** (`totalCents = subtotalCents`). | `PRODUCT_BUG` |
| 2 | Responsive | header, all pages | The mobile breakpoint is `max-width: 320px` instead of `768px`, so at 390 px / 834 px the hamburger never appears and the nowrap nav overflows horizontally (page scrolls sideways). The Figma mobile frame shows a hamburger button. | `PRODUCT_BUG` (responsive) |
| 3 | Visual | all primary buttons | Primary button fill is `#7C3AED` with a `2px` radius. The Figma design specifies `#2563EB` fill and `8px` radius. | `DESIGN_MISMATCH` |

| 4 | Functional | `/contact` (added later to validate feature-scoped runs) | The message field is never validated: submitting with an empty message shows "Message sent". | `PRODUCT_BUG` |

### Working behaviour (should NOT be reported)

- Login: `demo@shop.test` / `password123` shows "Welcome back, Demo User"; invalid credentials show
  "Invalid email or password"; client-side validation for email format and 8-char password.
- Invalid coupon shows "Invalid coupon code"; empty coupon shows "Enter a coupon code".
- Empty cart shows "Your cart is empty".
- Adding products on `/` increments the cart badge.
