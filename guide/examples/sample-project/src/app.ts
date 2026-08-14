import { AuthenticationError, login } from "./auth.js";

export interface LoginResponse {
  status: number;
  body: { userId?: string; error?: string };
}

export function handleLogin(email: string, password: string): LoginResponse {
  try {
    const user = login(email, password);
    return { status: 200, body: { userId: user.id } };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { status: 401, body: { error: "Unauthorized" } };
    }
    throw error;
  }
}
