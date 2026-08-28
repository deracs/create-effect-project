import { Schema } from "effect"

// A brand makes `UserId` a distinct type from `string`, so a raw string cannot
// be passed where an id is expected. `UserId.make` is the only way in.
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String
}) {}

export const UserCreate = Schema.Struct({
  name: Schema.String,
  email: Schema.String
})

export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: UserId
}) {}
