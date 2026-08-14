export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

const users: User[] = [
  { id: "u-1", email: "learner@example.com", passwordHash: "demo-secret" },
];

export function findUser(email: string): User | undefined {
  return users.find((user) => user.email === email);
}
