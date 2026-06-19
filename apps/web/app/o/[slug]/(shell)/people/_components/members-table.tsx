/**
 * members-table.tsx — Roster table for the People list page.
 *
 * Displays: Name, Email, Role badge, Status chip, Tags chips (+N overflow),
 * Phone.  Active-only toggle is owned by the parent page (client state).
 *
 * [VERIFY-6-A]: tags are free-text labels only; no FAA/eligibility meaning.
 * [VERIFY-6-D]: status is a roster flag, NOT a login gate.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { ROLE_LABELS } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type { OrgMemberListRow } from '@aeroops/api';

// ─── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: MembershipRole }) {
  const label = ROLE_LABELS[role] ?? role;
  return (
    <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-brand-ink">
      {label}
    </span>
  );
}

// ─── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
      Inactive
    </span>
  );
}

// ─── Tags chips (with +N overflow) ────────────────────────────────────────────

const MAX_VISIBLE_TAGS = 3;

function TagChips({ tags, tagCount }: { tags: string[]; tagCount: number }) {
  if (tagCount === 0) return null;
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflow = tagCount - visible.length;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
        >
          {tag}
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
          +{overflow}
        </span>
      )}
    </div>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface MembersTableProps {
  members: OrgMemberListRow[];
  slug: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function MembersTable({ members, slug }: MembersTableProps) {
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" aria-label="Members roster">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Name
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
              Email
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Role
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden lg:table-cell">
              Tags
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden xl:table-cell">
              Phone
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr
              key={member.userId}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/o/${slug}/people/${member.userId}`}
                  className="font-medium text-slate-900 hover:text-brand hover:underline underline-offset-2 transition-colors"
                >
                  {member.displayName}
                </Link>
              </td>
              <td className="px-4 py-3 text-slate-600 hidden sm:table-cell">
                {member.email}
              </td>
              <td className="px-4 py-3">
                <RoleBadge role={member.role} />
              </td>
              <td className="px-4 py-3 hidden md:table-cell">
                <StatusChip status={member.status} />
              </td>
              <td className="px-4 py-3 hidden lg:table-cell">
                <TagChips tags={member.tags} tagCount={member.tagCount} />
              </td>
              <td className="px-4 py-3 text-slate-600 hidden xl:table-cell">
                {member.phone ?? <span className="text-slate-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
