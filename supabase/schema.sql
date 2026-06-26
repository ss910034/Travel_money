-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trips (one active trip per LINE group at a time)
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  line_group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | settled
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trip members (users who have interacted in the trip)
CREATE TABLE trip_members (
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  user_line_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trip_id, user_line_id)
);

-- Expenses
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  payer_line_id TEXT NOT NULL,
  payer_name TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT NOT NULL,
  split_type TEXT NOT NULL DEFAULT 'equal', -- equal | custom
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expense splits (who owes what for each expense)
CREATE TABLE expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES expenses(id) ON DELETE CASCADE,
  user_line_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL
);

-- Indexes
CREATE INDEX idx_trips_group ON trips(line_group_id, status);
CREATE INDEX idx_expenses_trip ON expenses(trip_id);
CREATE INDEX idx_splits_expense ON expense_splits(expense_id);
CREATE INDEX idx_members_trip ON trip_members(trip_id);
