import { findUser, type User } from "./store.js";

export class AuthenticationError extends Error {}

export function login(email: string, password: string): User {
  const user = findUser(email);
  // 학습용 toy 비교다. 실제 서비스에서는 평문을 저장하지 말고 안전한 password hash를 검증한다.
  if (!user || user.passwordHash !== password) {
    throw new AuthenticationError("Unauthorized");
  }
  return user;
}
