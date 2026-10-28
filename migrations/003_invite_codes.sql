-- ============================================================
-- Grouply – Migration 003: Invite Codes
-- Run in Supabase SQL Editor AFTER 002_grouply_additions.sql
-- ============================================================

-- group_invites: single-use invite codes for private groups
CREATE TABLE IF NOT EXISTS group_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID REFERENCES groups(id) ON DELETE CASCADE,
  code        TEXT UNIQUE NOT NULL,               -- short alphanumeric code
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  used_by     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;

-- Only group admins can see invite codes for their groups
CREATE POLICY "invites: admins can read" ON group_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_invites.group_id
        AND gm.user_id  = auth.uid()
        AND gm.role     = 'admin'
    )
  );

-- Any member can create an invite (so others can share the link)
CREATE POLICY "invites: members can create" ON group_invites
  FOR INSERT WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

-- Backend service-role updates used_by when code is consumed (no user policy needed for UPDATE)
