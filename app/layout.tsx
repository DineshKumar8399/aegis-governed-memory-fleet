import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aegis · Governed Memory Fleet",
  description:
    "A governed memory layer for autonomous agent fleets. CockroachDB distributed vector search plus an Amazon Bedrock adversarial write-gate that blocks contradictions, duplicates and hallucinated drift before they enter shared memory.",
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
