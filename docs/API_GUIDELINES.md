# API Design Guidelines

All APIs in the system must follow these rules to ensure consistency, readability, and security across the codebase.

## 1. Versioning
All APIs are versioned and must prefix endpoints with `/api/v1/`.
- Example: `/api/v1/auth/register` or `/api/v1/user/profile`

---

## 2. Request Validation
Endpoints must validate incoming requests using Zod schemas via the `validateRequest` middleware.
- Place schema definitions in `*.validation.ts` inside their respective module folders.
- Wrap requests in a Zod object targeting `body`, `query`, or `params`.
- Use `.strict()` on registration/user-creation schemas to prevent clients from submitting undocumented fields.

---

## 3. Standard Response Format
Controllers must use the `sendResponse` utility to return responses. Standardized responses have this JSON format:

```json
{
  "code": 200,
  "message": "Data retrieved successfully",
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPage": 10
  },
  "data": [],
  "extra": {},
  "cached": false
}
```

---

## 4. Error Handling & ApiError

### Custom ApiError
Use the `ApiError` class to throw known operational exceptions. `ApiError` takes an HTTP status code (from `http-status-codes`) and a descriptive message:
```typescript
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';

throw new ApiError(StatusCodes.FORBIDDEN, 'You are not authorized to access this resource.');
```

### Global Error Handler
If an error is thrown, it is intercepted by the global error handler middleware. For client-side rendering, errors are formatted consistently:
- **Validation Errors (Zod)**: Includes detailed path mappings and descriptive error messages.
- **Mongoose / Cast Errors**: Formatted correctly to highlight validation issues.
- **Production Mode**: Stacks are hidden in production to ensure security.
