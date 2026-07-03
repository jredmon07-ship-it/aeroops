/**
 * components/BottomNav.tsx — Shared bottom navigation bar.
 *
 * READ-ONLY app: four destinations, all authenticated, all read-only.
 *   Schedule (/)  Fleet (/fleet)  Squawks (/squawks)  Alerts (/alerts)
 *
 * Simple stack-based navigation (no @react-navigation/bottom-tabs dependency
 * — expo-router's Stack already covers this app; this is a plain row of
 * Pressable links using useRouter().push, mirroring the existing header
 * pattern in src/app/index.tsx). Highlights the active tab via usePathname().
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, usePathname } from 'expo-router';

interface NavItem {
  href: '/' | '/fleet' | '/squawks' | '/alerts';
  label: string;
  /** Path prefix used to decide "active" (fleet detail routes still highlight Fleet). */
  matchPrefix: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Schedule', matchPrefix: '/' },
  { href: '/fleet', label: 'Fleet', matchPrefix: '/fleet' },
  { href: '/squawks', label: 'Squawks', matchPrefix: '/squawks' },
  { href: '/alerts', label: 'Alerts', matchPrefix: '/alerts' },
];

export function BottomNav(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <View style={styles.bar} accessibilityRole="tablist">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.matchPrefix);

        return (
          <Pressable
            key={item.href}
            style={styles.item}
            onPress={() => router.push(item.href)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={item.label}
          >
            <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingBottom: 4,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
  },
  labelActive: {
    color: '#1d4ed8',
  },
});
