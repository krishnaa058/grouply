-- ============================================================
-- Grouply – Base Schema (schema.sql)
-- Run in Supabase SQL Editor ONCE before any migrations.
-- ============================================================

-- Enable UUID extension (already on by default in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  bio           TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: anyone can read" ON profiles
  FOR SELECT USING (TRUE);

CREATE POLICY "profiles: owner can update" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- ============================================================
-- 2. GROUPS
-- ============================================================
CREATE TABLE IF NOT EXISTS groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  is_private    BOOLEAN DEFAULT TRUE,
  cover_url     TEXT,
  whatsapp_link TEXT,
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "groups: creator can update" ON groups
  FOR UPDATE USING (created_by = auth.uid());

-- ============================================================
-- 3. GROUP MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS group_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role       TEXT CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- Members of the group can read it; public groups are readable by all
-- (Defined after group_members table exists)
CREATE POLICY "groups: members can read" ON groups
  FOR SELECT USING (
    (NOT is_private)
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "group_members: members can read own group membership" ON group_members
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm2
      WHERE gm2.group_id = group_members.group_id
        AND gm2.user_id = auth.uid()
    )
  );

CREATE POLICY "group_members: admins can insert" ON group_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm2
      WHERE gm2.group_id = group_id
        AND gm2.user_id = auth.uid()
        AND gm2.role = 'admin'
    )
  );

CREATE POLICY "group_members: admins can delete" ON group_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM group_members gm2
      WHERE gm2.group_id = group_members.group_id
        AND gm2.user_id = auth.uid()
        AND gm2.role = 'admin'
    )
  );

-- ============================================================
-- 4. GROUP POSTS
-- ============================================================
CREATE TABLE IF NOT EXISTS group_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID REFERENCES groups(id) ON DELETE CASCADE,
  author_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  content         TEXT,
  media_url       TEXT,
  media_type      TEXT CHECK (media_type IN ('image', 'video', 'none')) DEFAULT 'none',
  is_public       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE group_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "group_posts: members can read" ON group_posts
  FOR SELECT USING (
    (is_public = TRUE)
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_posts.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "group_posts: members can insert" ON group_posts
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "group_posts: author can delete" ON group_posts
  FOR DELETE USING (author_id = auth.uid());

-- ============================================================
-- 5. GROUP MEDIA ARCHIVE
-- ============================================================
CREATE TABLE IF NOT EXISTS group_media_archive (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       UUID REFERENCES groups(id) ON DELETE CASCADE,
  uploaded_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  file_name      TEXT,
  file_url       TEXT,
  description    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE group_media_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "archive: members can read" ON group_media_archive
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_media_archive.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "archive: members can insert" ON group_media_archive
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 6. POLLS
-- ============================================================
CREATE TABLE IF NOT EXISTS polls (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID REFERENCES groups(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  question    TEXT NOT NULL,
  options     JSONB NOT NULL DEFAULT '[]',
  closes_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE polls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "polls: members can read" ON polls
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = polls.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "polls: members can insert" ON polls
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 7. POLL VOTES
-- ============================================================
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      UUID REFERENCES polls(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  option_index INT NOT NULL,
  voted_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (poll_id, user_id)
);

ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "poll_votes: members can read" ON poll_votes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = poll_votes.poll_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "poll_votes: members can vote" ON poll_votes
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = poll_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 8. EXPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID REFERENCES groups(id) ON DELETE CASCADE,
  paid_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  currency     TEXT DEFAULT 'USD',
  split_type   TEXT CHECK (split_type IN ('equal', 'custom')) DEFAULT 'equal',
  settled      BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses: members can read" ON expenses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = expenses.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "expenses: members can insert" ON expenses
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 9. EXPENSE SPLITS
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_splits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  UUID REFERENCES expenses(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  amount_owed NUMERIC(12,2) NOT NULL,
  settled     BOOLEAN DEFAULT FALSE
);

ALTER TABLE expense_splits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expense_splits: members can read" ON expense_splits
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM expenses e
      JOIN group_members gm ON gm.group_id = e.group_id
      WHERE e.id = expense_splits.expense_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 10. EXTERNAL LINKS
-- ============================================================
CREATE TABLE IF NOT EXISTS external_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID REFERENCES groups(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,  -- 'whatsapp','instagram','telegram','discord','drive','other'
  label       TEXT,
  url         TEXT NOT NULL,
  added_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE external_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "external_links: members can read" ON external_links
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = external_links.group_id AND gm.user_id = auth.uid()
    )
  );

CREATE POLICY "external_links: members can insert" ON external_links
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_id AND gm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 11. SIGNUP TRIGGER (collision-safe username derivation)
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
  -- Prefer full_name from Google OAuth metadata, else derive from email
  base_username := LOWER(
    REGEXP_REPLACE(
      COALESCE(
        NEW.raw_user_meta_data->>'preferred_username',
        SPLIT_PART(NEW.email, '@', 1)
      ),
      '[^a-z0-9_]', '', 'g'
    )
  );

  -- Ensure non-empty
  IF base_username = '' THEN
    base_username := 'user';
  END IF;

  candidate := base_username;

  -- Collision-safe: append random 4-char hex suffix until unique
  LOOP
    BEGIN
      INSERT INTO profiles (id, username, display_name, avatar_url)
      VALUES (
        NEW.id,
        candidate,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        NEW.raw_user_meta_data->>'avatar_url'
      );
      EXIT; -- success
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

-- Attach trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- 12. create_group() SECURITY DEFINER function
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
