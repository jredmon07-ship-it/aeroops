import { redirect } from 'next/navigation';

/**
 * /o/[slug]/reporting — index redirect.
 *
 * The reporting hub's landing surface is the operational Reports deep-dive.
 * A bare /reporting (hand-typed or stale link) redirects to /reporting/reports
 * so it never dead-ends. The role gate lives on the destination page (and in
 * the reporting:access-checked API reads).
 */
export default async function ReportingIndexPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/o/${slug}/reporting/reports`);
}
