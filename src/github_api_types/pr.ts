import { GithubUser, GithubOrg } from './user'
import { GithubRepo } from './repo'

interface GithubLabel {
  id: number
  node_id: string
  url: string
  name: string
  /** hex code without # */
  color: string
  default: boolean
}

export interface GithubWebhookPullRequestEvent {
  action:
    | 'assigned'
    | 'unassigned'
    | 'labeled'
    | 'unlabeled'
    | 'opened'
    | 'edited'
    | 'closed'
    | 'reopened'
    | 'synchronize'
    | 'ready_for_review'
    | 'locked'
    | 'unlocked'
  number: number
  pull_request: GithubApiPr
  before: unknown
  after: unknown
  repository: GithubRepo
  organization: GithubOrg
  sender: GithubUser
}

interface PrTip {
  /** org:proj combo */
  label: string
  /** branch name */
  ref: string
  /** commit sha */
  sha: string
  user: GithubUser
  repo: GithubRepo
}

export interface GithubApiPr {
  url: unknown
  id: unknown
  node_id: unknown
  html_url: unknown
  diff_url: unknown
  patch_url: unknown
  issue_url: unknown
  commits_url: unknown
  review_comments_url: unknown
  review_comment_url: unknown
  comments_url: unknown
  statuses_url: unknown
  number: number
  state: unknown
  locked: unknown
  title: string
  user: GithubUser
  body: string
  labels: GithubLabel[]
  milestone: unknown
  active_lock_reason: unknown
  /** ISO8601 date string */
  created_at: string
  /** ISO8601 date string */
  updated_at: string
  closed_at: unknown
  merged_at: unknown
  merge_commit_sha: unknown
  assignee: unknown
  assignees: unknown
  requested_reviewers: unknown
  requested_teams: unknown
  head: PrTip
  base: PrTip
  _links: unknown
  author_association: unknown
  draft: boolean
  merged: boolean
  mergeable: boolean
  rebaseable: boolean
  mergeable_state: unknown
  merged_by: unknown
  comments: number
  review_comments: number
  maintainer_can_modify: boolean
  commits: number
  additions: number
  deletions: number
  changed_files: number
}
