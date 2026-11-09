# Herdr OMP 会话复制

本上下文描述 Herdr agent 列表中可复制的 OMP 会话标识.

## Language

**OMP session ID**:
OMP 当前会话的完整标识, 复制结果为不附带命令或说明的纯文本.
_Avoid_: terminal ID, session file path

**Terminal address**:
Herdr 中一个运行终端的地址. 它标识终端, 不等同于该终端当前承载的 OMP 会话.
_Avoid_: OMP session ID

**可复制会话**:
已确认属于 OMP 且可确定当前 session ID 的会话. 不能确定当前 ID 的会话不显示复制按钮.
