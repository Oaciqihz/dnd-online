import {
  INTERNAL_TOKEN,
  INTERNAL_TOKEN_HEADER,
  SOCKET_HTTP_URL,
} from "./internal-auth";

/**
 * 从 Next 进程通知 Socket 进程：这个人已经被移出房间，把他赶下线。
 *
 * 为什么必须单独通知：两个进程各自独立，Server Action 删掉数据库记录后，
 * 对方的长连接仍然挂在 Socket 进程的房间频道里，会继续收到广播。
 * 只靠数据库，他要等到下次刷新页面才会发现自己已经不在了。
 *
 * 这个函数的失败是「可容忍」的：数据已经删了，对方只是晚一点掉线。
 * 所以这里不抛异常，只打日志，不阻断踢人这个动作本身。
 */
export async function notifyRoomKick(
  code: string,
  userId: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${SOCKET_HTTP_URL}/internal/kick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({ code, userId }),
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`[rooms] 实时服务拒绝了踢人通知，HTTP ${response.status}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      "[rooms] 连不上实时服务，成员已从名单里删除，但对方要刷新后才会掉线",
      error,
    );
    return false;
  }
}
