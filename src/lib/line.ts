const LINE_API = 'https://api.line.me/v2/bot'

async function lineGet(path: string) {
  const res = await fetch(`${LINE_API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  })
  if (!res.ok) return null
  return res.json()
}

export async function getGroupMemberIds(groupId: string): Promise<string[]> {
  const ids: string[] = []
  let start: string | undefined

  do {
    const url = `/group/${groupId}/members/ids${start ? `?start=${start}` : ''}`
    const data = await lineGet(url)
    if (!data) break
    ids.push(...(data.memberIds ?? []))
    start = data.next
  } while (start)

  return ids
}

export async function getGroupMemberProfile(
  groupId: string,
  userId: string
): Promise<{ userId: string; displayName: string; pictureUrl?: string } | null> {
  return lineGet(`/group/${groupId}/member/${userId}`)
}

export async function getBotId(): Promise<string | null> {
  const data = await lineGet('/info')
  return data?.userId ?? null
}
