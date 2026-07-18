# Testing Workflow and Development Process

This document describes the validation flow and quality checks required for code contributions.

## 1. Development Lifecycle
Follow this sequence when implementing new features or bug fixes:
1. **Research & Plan**: Analyze dependencies, affected models, and side effects.
2. **Implement Logic**: Write type-safe TypeScript code under the respective module.
3. **Format & Lint**: Ensure code complies with code style guides:
   ```bash
   npm run lint:fix
   npm run prettier:fix
   ```
4. **Compile Check**: Confirm TypeScript compiles successfully with no compilation errors:
   ```bash
   npx tsc --noEmit
   ```

---

## 2. Testing Guidelines

### Unit and Integration Testing
- Create localized unit test suites inside respective module folders if applicable.
- Ensure all business rule branches (e.g. status updates, validation error limits) are covered.

### Manual Verification via Scratch Scripts
For complex queries or integration operations (like database triggers or queue setups):
- Create temporary scripts inside `src/` (e.g. `src/test_scratch.ts`).
- Establish connections to test database collections, execute service methods directly, assert states, and clean up test data.
- Run these scripts using `npx ts-node src/test_scratch.ts`.
- **Note**: Always delete these temporary scratch files before committing code to version control.
