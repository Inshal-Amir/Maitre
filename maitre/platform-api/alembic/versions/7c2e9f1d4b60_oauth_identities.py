"""oauth identities (sign in with Google)

Revision ID: 7c2e9f1d4b60
Revises: 4a24f589b34a
Create Date: 2026-10-05 20:30:00
"""
from alembic import op
import sqlalchemy as sa

revision = '7c2e9f1d4b60'
down_revision = '4a24f589b34a'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'oauth_identities',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('provider', sa.String(length=32), nullable=False),
        sa.Column('subject', sa.String(length=255), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('provider', 'subject', name='oauth_identities_provider_subject_uq'),
    )
    op.create_index(op.f('ix_oauth_identities_user_id'), 'oauth_identities', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_oauth_identities_user_id'), table_name='oauth_identities')
    op.drop_table('oauth_identities')
