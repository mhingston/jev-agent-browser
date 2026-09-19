import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error("TYPESAFE_API_KEY is unset; export it before running the live smoke test.");
  process.exit(2);
}

const client = new TypeSafeClient({ defaultModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0" });
const response = await client.systemOne({
  state: {
    goal: "Open the settings page",
    page: { title: "Settings", text: "The settings page is visible." },
  },
  questions: {
    goal_completed: noul("Does the current `page` show that `goal` is complete?"),
  },
});

console.log(JSON.stringify({
  model: response.model,
  goal_completed: response.answers.goal_completed,
  usage: response.usage,
}, null, 2));
