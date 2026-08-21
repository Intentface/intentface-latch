import { redirect } from "next/navigation";

// The site is only docs; keep one canonical home.
export default function Home() {
  redirect("/docs");
}
