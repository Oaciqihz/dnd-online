import {
  INTERNAL_TOKEN,
  INTERNAL_TOKEN_HEADER,
  SOCKET_HTTP_URL,
} from "./internal-auth";

/**
 * 从 Next 进程调用 Socket 进程的内部接口。
 *
 * 两个进程各自独立运行，没有共享内存，跨进程的动作只能这样通知一次。
 * 这里刻意不抛异常：调用方此时已经改完数据库了，
 * 通知失败只会让别人的界面慢一点更新，不该把整个动作回滚。
 */
async function postInternal(
  path: string,
  body: unknown,
  label: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${SOCKET_HTTP_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`[socket-notify] ${label}被拒绝，HTTP ${response.status}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      `[socket-notify] 连不上实时服务，${label}没有生效，需要刷新页面才看得到变化`,
      error,
    );
    return false;
  }
}

/**
 * 告诉 Socket 进程：这个人已经被移出房间，把他赶下线。
 *
 * 只删数据库是不够的 —— 对方的长连接仍然挂在房间频道里，会继续收到广播，
 * 要等到下次刷新页面才「突然」发现自己已经不在了。
 */
export async function notifyRoomKick(
  code: string,
  userId: string,
): Promise<boolean> {
  return postInternal("/internal/kick", { code, userId }, "移出成员");
}

/**
 * 告诉 Socket 进程：这个房间的角色卡数据变了，重播一次房间状态。
 *
 * 角色卡摘要是随 room:state 一起下发的，所以不需要单独的事件类型，
 * 也不需要知道是谁的卡变了 —— 重播一次，所有人的界面自动对齐。
 */
export async function notifyRoomRefresh(code: string): Promise<boolean> {
  return postInternal("/internal/refresh", { code }, "刷新房间状态");
}
