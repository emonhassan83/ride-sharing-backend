# Coding Rules and Style Guidelines

To keep the codebase maintainable, secure, and clean, all developers must adhere to the following standards.

## 1. TypeScript Standards
- **Strict Mode**: `strict: true` is configured in `tsconfig.json`. Ensure all code strictly defines types.
- **Explicit Returns**: Functions (especially service functions and database queries) should document their expected return types.
- **Avoid Implicit `any`**: Explicitly declare types for all parameters and variables. Use `any` only for flexible payload parameters.

---

## 2. Formatting & Linting
- **ESLint**: Run `npm run lint:check` to check for issues and `npm run lint:fix` to auto-resolve them.
- **Prettier**: Maintain consistent code styling. Use `npm run prettier:fix` to format all code.
- **Line Length**: Keep line lengths reasonable (max 100-120 chars) to prevent readability issues on smaller screens.

---

## 3. Naming Conventions

### File Naming
Use camelCase for standard codebase files with suffixes that denote the component type:
- Controller: `name.controller.ts`
- Service: `name.service.ts`
- Route: `name.routes.ts`
- Interface: `name.interface.ts`
- Validation: `name.validation.ts`
- Constant: `name.constant.ts`

### Variables & Functions
- **Variables / Instances**: camelCase (e.g. `const driverRides = await ...`)
- **Classes / Types / Interfaces**: PascalCase (e.g. `export interface TPassenger`, `class QueryBuilder`)
- **Constants**: UPPER_SNAKE_CASE (e.g. `PAYMENT_STATUS = { paid: 'paid' }`)

---

## 4. Error Handling
- Never throw raw strings or generic error objects. Always throw an instance of `ApiError`.
- Wrap controllers with the `catchAsync` helper to automatically catch errors and bubble them to the global error middleware.
