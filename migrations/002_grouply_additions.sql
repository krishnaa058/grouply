-- ============================================================
-- Grouply – Migration 002: Schema Additions (§3 of master prompt)
-- Run AFTER schema.sql in Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- 3.1  groups: add missing columns
--      (category & is_private already in schema.sql base;
--       whatsapp_link kept on groups for quick access + in external_links)
-- ============================================================
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS drive_folder_link TEXT;   -- 5A link-only mode

-- ============================================================
-- 3.2  post_comments
--      Members of the post's group can read/insert; author can delete own.
-- ============================================================
CREATE TABLE IF NOT EXISTS post_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID REFERENCES group_posts(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "post_comments: members can read" ON post_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_posts gp
      JOIN group_members gm ON gm.group_id = gp.group_id
      WHERE gp.id = post_comments.post_id
        AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "post_comments: members can insert" ON post_comments
  FOR INSERT WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM group_posts gp
      JOIN group_members gm ON gm.group_id = gp.group_id
      WHERE gp.id = post_id
        AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "post_comments: author can delete own" ON post_comments
  FOR DELETE USING (author_id = auth.uid());

-- ============================================================
-- 3.3  proposals + proposal_votes
-- ============================================================
CREATE TABLE IF NOT EXISTS proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID REFERENCES groups(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('add_member', 'remove_member', 'publish_post')),
  target_user_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_post_id  UUID REFERENCES group_posts(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status          TEXT DEFAULT 'open' CHECK (status IN ('open', 'passed', 'rejected')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "proposals: members can read" ON proposals
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = proposals.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "proposals: members can create" ON proposals
  FOR INSERT WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id  UUID REFERENCES proposals(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  vote         TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
  PRIMARY KEY (proposal_id, user_id)
);

ALTER TABLE proposal_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "proposal_votes: members can read" ON proposal_votes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM proposals p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = proposal_votes.proposal_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "proposal_votes: members can vote" ON proposal_votes
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM proposals p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = proposal_id AND gm.user_id = auth.uid()
    )
  );

-- Server-side proposal resolution function (called by backend service-role)
-- Rule: passes when yes-votes > half of current group member count
CREATE OR REPLACE FUNCTION resolve_proposal(p_proposal_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id      UUID;
  v_type          TEXT;
  v_target_user   UUID;
  v_target_post   UUID;
  v_yes_count     INT;
  v_member_count  INT;
  v_result        TEXT;
BEGIN
  SELECT group_id, type, target_user_id, target_post_id
    INTO v_group_id, v_type, v_target_user, v_target_post
    FROM proposals
   WHERE id = p_proposal_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN 'not_found_or_closed';
  END IF;

  SELECT COUNT(*) INTO v_yes_count
    FROM proposal_votes
   WHERE proposal_id = p_proposal_id AND vote = 'yes';

  SELECT COUNT(*) INTO v_member_count
    FROM group_members
   WHERE group_id = v_group_id;

  IF v_yes_count > (v_member_count / 2.0) THEN
    -- Apply the result
    CASE v_type
      WHEN 'add_member' THEN
        INSERT INTO group_members (group_id, user_id, role)
        VALUES (v_group_id, v_target_user, 'member')
        ON CONFLICT DO NOTHING;
      WHEN 'remove_member' THEN
        DELETE FROM group_members
         WHERE group_id = v_group_id AND user_id = v_target_user;
      WHEN 'publish_post' THEN
        UPDATE group_posts SET is_public = TRUE WHERE id = v_target_post;
    END CASE;

    UPDATE proposals SET status = 'passed' WHERE id = p_proposal_id;
    v_result := 'passed';
  ELSE
    UPDATE proposals SET status = 'rejected' WHERE id = p_proposal_id;
    v_result := 'rejected';
  END IF;

  RETURN v_result;
END;
$$;

-- ============================================================
-- 3.4  group_drive_connections  (service-role only, NO user policies)
-- ============================================================
CREATE TABLE IF NOT EXISTS group_drive_connections (
  group_id                UUID PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  connected_by            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  refresh_token_encrypted TEXT NOT NULL,
  drive_root_folder_id    TEXT,
  status                  TEXT DEFAULT 'active' CHECK (status IN ('active', 'broken', 'revoked')),
  connected_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE group_drive_connections ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only service-role backend can access this table.
-- This ensures the encrypted refresh token is never exposed to browsers.

-- ============================================================
-- 3.5  group_media_archive: add new columns
-- ============================================================
ALTER TABLE group_media_archive
  ADD COLUMN IF NOT EXISTS drive_file_id   TEXT,
  ADD COLUMN IF NOT EXISTS mime_type       TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes      BIGINT,
  ADD COLUMN IF NOT EXISTS thumbnail_url   TEXT;

-- ============================================================
-- 3.6  handle_new_user trigger: collision-safe (already in schema.sql)
--      This migration ensures the latest version replaces any old one.
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base_username TEXT;
  candidate     TEXT;
  suffix        TEXT;
  attempt       INT := 0;
BEGIN
  base_username := LOWER(
    REGEXP_REPLACE(
      COALESCE(
        NEW.raw_user_meta_data->>'preferred_username',
        SPLIT_PART(NEW.email, '@', 1)
      ),
      '[^a-z0-9_]', '', 'g'
    )
  );

  IF base_username = '' THEN
    base_username := 'user';
  END IF;

  candidate := base_username;

  LOOP
    BEGIN
      INSERT INTO profiles (id, username, display_name, avatar_url)
      VALUES (
        NEW.id,
        candidate,
        COALESCE(
          NEW.raw_user_meta_data->>'full_name',
          NEW.raw_user_meta_data->>'name'
        ),
        NEW.raw_user_meta_data->>'avatar_url'
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      attempt := attempt + 1;
      suffix := LOWER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 4));
      candidate := base_username || '_' || suffix;
      IF attempt > 10 THEN
        RAISE EXCEPTION 'Could not generate unique username after 10 attempts';
      END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- 3.7  create_group() SECURITY DEFINER (already in schema.sql;
--      replace here to ensure latest version is applied)
-- ============================================================
CREATE OR REPLACE FUNCTION create_group(
  p_name        TEXT,
  p_description TEXT DEFAULT NULL,
  p_category    TEXT DEFAULT NULL,
  p_is_private  BOOLEAN DEFAULT TRUE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_group_id UUID;
BEGIN
  INSERT INTO groups (name, description, category, is_private, created_by)
  VALUES (p_name, p_description, p_category, p_is_private, auth.uid())
  RETURNING id INTO new_group_id;

  INSERT INTO group_members (group_id, user_id, role)
  VALUES (new_group_id, auth.uid(), 'admin');

  RETURN new_group_id;
END;
$$;
