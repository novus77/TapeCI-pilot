# 自建电路铸造（替代 P5 供应商）

Date: 2026-10-28. Status: **proposed, not implemented.** Branch: main.
Authoring language: 中文（与既有 SPEC 一致）。

本文档替代 `2026-10-27-deepseek-development-spec.md` 的 P5「采购来源」。
P5 假设存在一个第三方供应商，通过外部订单交付电路 NFT。本方案证明那个假设
不必要：**协议自己的 factory 就是供应方**，用户可以用自己的钱包现场铸造，
不需要平台做中间人，也不需要平台碰任何私钥。

---

## 0. 这个决定改变了什么

### 原 P5 的设计

```
用户 → 平台 → 第三方供应商 API → 外部订单 → 供应商交付 NFT → 平台核验
                ↑ external_pending、订单号、交付证据、退款争议
```

问题：没有供应商，所以整条路径是死的。`offers` 永远 `available: false`。

### 本方案

```
用户钱包 → factory.mint(NAND) → factory.tapeout(网表, nIn, nOut) → 得到电路 NFT
        → opener.open(processor, tokenId) → 得到 ERC-6551 容器
```

**没有外部方，没有订单，没有交付争议。** 每一步都是用户自己签名、自己付费、
链上可验证。平台只负责：构造正确的 calldata、展示真实价格、核验结果。

### 已经证明的等价性

`id.tapeout.link` 是官方的一键开通工具，纯前端 dApp。它 import 的是
`TapeKit/kernel/src/{config,abi,keccak}.js` 与 `tapeout-netlist.js`。核对结果：

| 项 | 官方 `id.tapeout.link` | 本仓库 | 一致 |
| --- | --- | --- | --- |
| X Layer factory | `0x1f09daefa827f02cbb40967cc91b259763760761` | 同 | ✅ |
| X Layer opener | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` | 同 | ✅ |
| X Layer registry | `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` | 同 | ✅ |
| X Layer binding | `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` | 同 | ✅ |
| 双 RPC 严格读取 | OKX + dRPC 两家一致 | 已实现 | ✅ |
| 容器推导 `accountOf` | 有 | 已实现（P3） | ✅ |
| 开通 `open` + `FEE()` | 有 | 已实现（P3） | ✅ |

**结论：我们已经在用同一套合约、同一套读取纪律。缺的只有「铸造电路」这一段。**

---

## 1. 范围与非目标

### 阶段 A（本文档定义）

- `packages/tapekit/src/netlist.ts`：网表编码器（NAND/LATCH/REF → 字节流）
- `packages/tapekit/src/tapeout.ts`：mint + tapeout 的 calldata 构造与价格读取
- `apps/api/src/provisioning/sources/tapeout.ts`：把铸造包装成 `acquisition` 步骤的报价来源
- **fork 验证**：在 Anvil fork 上完整跑通 mint → tapeout → open，得到真实 tokenId 与容器
- 主网页面的铸造入口**默认关闭**（功能开关），fork 验证通过后才打开

### 明确不做

| 不做 | 原因 |
| --- | --- |
| 平台代付 gas / 平台持有用户私钥 | 红线：不保存用户主钱包私钥 |
| 主网真实交易（本阶段） | 需先 fork 验证 + 用户明确授权费用上限 |
| 多链（BNB/Base） | 本仓库只支持 X Layer 196；引入多链是独立工程 |
| 替代 `id.tapeout.link` | 它是官方工具，我们不与它竞争；本方案是**把同样的能力做进 TapeCI 的工作流** |
| 复杂电路编辑/优化 | 首期只做固定的最小电路（见 §3） |

### 与既有 P3 的关系

铸造产出 tokenId 后，**后续完全复用 P3**：

```
acquisition（本方案新增）
   ↓ tokenId 已知
open（P3 已实现）
   ↓ 容器地址已知
进入项目（P4/P6 已实现）
```

`PreparationStepKind` 已有 `"acquisition"` 值，`ResourceRef` 已有 `tokenId: string`
（未知时为 `null`，见 §5 DTO）。**不需要改冻结的 DTO。**

---

## 2. 链上真实签名（已核实，来自官方 `SIGS` 表）

```ts
cpuCount()                                    // factory: 处理器数量
cpuAt(uint256)                                // factory: 第 i 号处理器地址
name()                                        // 处理器: 处理器名
TAPEOUT_FEE()                                 // 处理器: 流片费（必须精确等于 msg.value）
transistors()                                 // 处理器: 晶体管合约地址
circuitInfo(uint256) returns (uint256,uint256,uint256,uint256)
tapeout(bytes,uint32,uint32)                  // 处理器: 流片，返回新 tokenId
nextId()                                      // 处理器: 下一个编号（预计 = nextId + 1）

NAND()                                        // 晶体管: NAND 型号 id
mintPrice()                                   // 晶体管: 单价
protocolFee()                                 // 晶体管: mint 协议费
supplyCap() / minted()                        // 晶体管: 余量
balanceOf(address,uint256)                    // 晶体管: 余额
mint(uint256,uint256)                         // 晶体管: mint(id, amount)，value = cost

FEE()                                         // opener: 开通费
accountOf(address,uint256)                    // opener: 推导容器地址
isOpened(address,uint256)                     // opener: 是否已开通
isDeployed(address,uint256)                   // opener: 容器是否已部署
open(address,uint256)                         // opener: 开通，value = FEE()

// 事件
TapedOut(uint256,address,uint32,uint32)       // topic0 = keccak256(签名全文)
```

**注意**：事件 topic0 是完整签名的 keccak256，**不能按函数 selector 截断**。这是官方
实现里的原话，也是一个容易踩的坑。

---

## 3. 网表编码（首个电路）

### 格式（与 `NetlistVM.sol` 逐条对应）

信号空间：`[0]` 常量 0、`[1]` 常量 1、`[2 .. 2+nIn-1]` 输入引脚，之后每个元件按声明
顺序产出信号。

| 元件 | 字节布局 | 总长 | 产出信号 |
| --- | --- | --- | --- |
| NAND | `0x00 \| a(u24 BE) \| b(u24 BE)` | 7 | 1 |
| LATCH | `0x01 \| d(u24 BE)` | 4 | 1 |
| REF | `0x02 \| cpu(20B) \| cid(u64 BE) \| rIn(1B) \| rOut(1B) \| rIn×输入索引(u24 BE)` | 30+3·rIn | rOut |

校验规则：
- NAND 的两个输入必须指向**已存在**的信号，禁止前向引用；
- LATCH 的 `d` 可以指向后面的信号（时序反馈），但必须落在信号空间内；
- 输出 = 信号空间最后 `nOut` 个信号，所以**元件顺序决定输出引脚**。

多字节整数一律大端；`state`/`inputs`/`outputs` 是位打包、位序小端。

### 首期唯一的电路：反相器

```
out = NOT in        nIn=1, nOut=1, ops=[nand(2, 2)]
```

一个 NAND 的两个输入接同一个信号就是反相。链上得到 `gateCount=1`、`nState=0`。
这是官方工具用的同一个最小电路，**不引入优化、不引入多电路选择**。

**必须记录的理由**：流片不可逆、要真实付费。首期只提供一个已被验证的最小电路，
比让用户面对一堆无法验证的电路选项更诚实。

---

## 4. 成本模型（全部链上读，不估算）

| 项 | 来源 | 何时支付 |
| --- | --- | --- |
| 晶体管 mint 费 | `mintPrice() × 数量 + protocolFee()` | 铸造前 |
| 流片费 | `TAPEOUT_FEE()`，**必须精确**，多一分少一分都 revert | 流片时 |
| 开通费 | `FEE()` | 开通时（走既有 P3） |

首期需要 **1 枚 NAND**（单门电路）。若用户已有余额，跳过 mint——这是省钱的真实差异，
必须实现。

**价格必须逐行展示、不合并**（§9.2 的既有规则）：

```
晶体管 mint     0.00xx OKB   精确
流片费          0.00xx OKB   精确（必须精确等于）
开通费          0.08  OKB    精确
gas（估算）     0.00xx OKB   估算
```

### 编号的不确定性（必须如实告知）

预计编号 = `nextId() + 1`。**如果别人同时流片且先上链，实际编号会更大。**
以收据里 `TapedOut` 事件的第一个参数为准。这个事实必须写在确认页上，
不能让用户以为编号是锁定的。

---

## 5. DTO 与状态（复用冻结契约，不改字段）

`acquisition` 步骤在铸造前 tokenId 未知，冻结 DTO 已经允许：

```ts
// packages/shared/src/provisioning.ts（已存在，不改）
PreparationQuoteStep.resource: ResourceRef | null   // null = tokenId 尚未确定
PreparationStep.resource: ResourceRef | null        // 同上
```

§9.3 的既有规则适用：

> acquisition 后 tokenId 才确定的，使用 acquisition 结果解析，生成 **open 的新报价修订**
> 并让用户确认；不得把初始估计当可无限执行的授权。

也就是说：**铸造和开凡是两次独立的报价与确认**。用户确认铸造、铸造完成、看到实际
tokenId，再确认开通。不能合并成一次签名。

---

## 6. 双 RPC 纪律（沿用既有实现）

`packages/verifier/src/operators.ts` 已强制 ≥2 家独立运营方，X Layer 实测为
OKX（`rpc.xlayer.tech` / `xlayerrpc.okx.com`）与 dRPC（`xlayer.drpc.org`）。

铸造流程中每一次**付费决策前**的读取都必须两家一致：

- `nextId()`、`TAPEOUT_FEE()`、`mintPrice()`、`protocolFee()`、`FEE()`；
- 流片后读 `TapedOut` 事件解析真实 tokenId；
- 任何一家不可用 → `unavailable`，不是 `false`，不继续付费（§9.2）。

---

## 7. 阶段 A 验收

### fork 测试（`tests/fork/tapeout-mint.test.ts`，新增）

在 X Layer 196 的 Anvil fork 上，用 `anvil_impersonateAccount` + `anvil_setBalance`
模拟一个有钱包但无电路的用户，完整跑通：

| # | 断言 |
| --- | --- |
| A-1 | `cpuAt(0)` 得到处理器地址，与配置一致 |
| A-2 | 读取 `TAPEOUT_FEE`/`mintPrice`/`protocolFee`/`FEE`，两家 operator 一致 |
| A-3 | `mint(NAND, 1)` 成功，余额从 0 变 1 |
| A-4 | `tapeout(网表, 1, 1)` 成功，`msg.value` 精确等于 `TAPEOUT_FEE` |
| A-5 | 从收据解析 `TapedOut` 得到真实 tokenId，且 ≥ 预计值 |
| A-6 | 网表字节与官方编码器对同一电路产出**逐字节相同** |
| A-7 | `accountOf(processor, tokenId)` 得到容器地址；`isOpened` 为 false |
| A-8 | `open(processor, tokenId)` 付 `FEE()` 后 `isOpened` 为 true |
| A-9 | `msg.value` 少付 1 wei 时 **revert**（证明"必须精确"不是文档措辞） |
| A-10 | 同一电路第二次 `tapeout` 得到**不同** tokenId（不是同一个资产） |

### 单元测试（`tests/unit/tapekit-netlist.test.ts`，新增）

| # | 断言 |
| --- | --- |
| U-1 | `nand(2,2)` 编码为 `0x00000002000002`（7 字节：操作码 `00` + 两个 u24 大端索引 `000002` `000002`） |
| U-2 | 前向引用的 NAND 输入被拒绝（不得构造非法网表） |
| U-3 | LATCH 可以指向后面的信号（合法反馈），但不越界 |
| U-4 | 输出引脚 = 信号空间最后 `nOut` 个 |
| U-5 | 位打包的位序是小端 |
| U-6 | 空网表 / `nIn=0` / `nOut` 超过信号总数 均被拒绝 |

### 门禁

`npm run check` exit 0；`tests/unit` 与 `tests/p2` 不回归；完整 `tests/fork` 通过。

---

## 8. 上线开关（阶段 A 不打开）

```bash
# 默认关闭。fork 验证通过 + 用户明确授权费用上限后才可打开。
TAPECI_TAPEOUT_MINT_ENABLED=false
```

关闭时的行为：
- `/v1/resources/offers` 继续 `available: false`，`unavailableKind: "not_configured"`；
- 「一键开通」入口不渲染；
- 引导用户去 `https://id.tapeout.link/` 自己铸造，回来我们发现他的新电路。

打开后：入口渲染，但**每一步仍然是用户自己签名**。

---

## 9. 风险与已知限制

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **不可逆** | 流片一旦上链，电路就是那个编号，不能撤销 | 确认页明写"步骤不可逆、费用真实支付"，并要求勾选 |
| **并发的编号漂移** | 别人抢先上链会让实际编号大于预计 | 明示"以收据 `TapedOut` 为准"，不承诺具体编号 |
| **`msg.value` 必须精确** | 多一分少一分都 revert | 用链上读到的值构造，不做任何四舍五入；A-9 用测试钉死 |
| **首期只有一个电路** | 用户没有选择 | 如实说明；复杂电路是后续阶段 |
| **不替代官方工具** | `id.tapeout.link` 已经能用且是官方维护 | 我们不与它竞争；我们的价值是把它接进 TapeCI 的后续流程（开通→项目→发布） |
| **主网未验证** | 阶段 A 只做 fork | 打开开关前必须有主网小额验证 + 用户授权上限 |

---

## 10. 完成后的完整用户旅程

这条链路补上后，一个**完全没有电路的新用户**可以：

```
1. 连接钱包
2. 看到「你还没有电路」+ 两个选项：
   a. 去官方工具自己铸造（外链，我们引导回来）
   b. 在本站一键铸造（阶段 A 验证通过并打开开关后）
3. 铸造完成 → 得到 tokenId
4. 确认开通报价 → 钱包签 open → 得到容器
5. 创建项目 → 绑定仓库 → 构建 → 审批 → 发布 DeWEB 网站
```

**这才是产品闭环。** 现在缺的只有第 2b 到 3 这一段。

---

## 11. 这次不写代码的部分，以及为什么

| 未做 | 原因 |
| --- | --- |
| 主网真实铸造 | 需要用户明确授权费用上限。红线禁止未经授权的真实付费 |
| 平台代付 | 红线：不保存用户私钥 |
| 多电路选择 | 无法验证的选项比没有选项更糟 |
| 与官方工具竞争 | 它已存在且是官方维护；我们的价值在下游 |

**下一步需要用户确认的唯一一件事**：是否授权在 fork 验证通过后进行**一次**主网小额
铸造验证，以及费用上限是多少。在那之前，本方案可以完整实现并 fork 验证，主网开关
保持关闭。

---

---

## 12. 实测结果（2026-10-28）：**可行，但必须按处理器挑选，不能只看第 0 号**

本节是实施后补写的。第一版结论错了，原因值得记录：**我只测了 processor 0 就下了全局结论。**

### 我错在哪

`factory.cpuCount()` 在 X Layer 上是 **398**，即有 398 个处理器，每个处理器有**自己独立的**
晶体管供应。processor 0 的晶体管确实已售罄（`minted == supplyCap == 100000`），但那只说明
**第 0 号**没有余量。

全量扫描 398 个处理器（同一 pinned block）的结果：

| 结果 | 数量 |
| --- | --- |
| 仍有晶体管余量 | **357 / 398** |
| 已售罄 | 41 |

**357 个可选，用户总有得选。** 这正是 `id.tapeout.link` 让用户先选处理器的原因——它不是在
做一个无谓的选择步骤，而是在**避开售罄的那些**。

### 可行的处理器样例（同一 pinned block 实测）

| cpu # | processor | 余量 | mintPrice | protocolFee | TAPEOUT_FEE | nextId |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | `0xE0EF4Fff…05ff` | 99,819 | 0.01 OKB | 0.00066 | 0.0013 | 25 |
| **4** | `0x68f65046…40cc` | 99,819 | **0.00066 OKB** | 0.00066 | 0.0013 | 10 |
| 5 | `0xFD7B31b5…7819` | 62,631 | 0.001 OKB | 0.00066 | 0.0013 | 13 |

**单价差异巨大**（0.01 vs 0.00066，相差 15 倍），所以"选哪个处理器"是一个**真实的价格决策**，
不是形式。平台必须把价格摆出来让用户选，并在选定后再报价。

### 修正后的流程

```
1. GET /v1/resources/processors  → 返回 398 个处理器
2. 对每个处理器读 minted/supplyCap/mintPrice/protocolFee/TAPEOUT_FEE
3. 过滤掉余量为 0 的（41 个），按总成本排序
4. 用户选一个有货的处理器 → 该处理器的价格进入报价
5. mint → tapeout → open（P3 既有能力）
```

**关键**：不能写死"用 processor 0"。报价必须绑定用户选定的处理器，价格来自那个处理器的
`transistors()` 合约。

### 修正后的成本模型

```
晶体管 mint      mintPrice + protocolFee   （各处理器不同，实测 0.00066 ~ 0.01+ OKB）
流片费           TAPEOUT_FEE                （实测 0.0013 OKB，多数处理器相同）
开通费           FEE()                      （实测 0.08 OKB）
```

按 processor 4 算：单门电路总成本约 **0.083 OKB** 出头。

### 仍然成立的事实

- `TAPEOUT_FEE` 必须精确等于 `msg.value`（欠付 1 wei 实测 revert）；
- 流片要求真实持有该处理器的晶体管（零余额地址付足费用仍 revert）；
- `accountOf(processor, tokenId)` 推导容器正常（`0xE2E5FfD8…50aB`）；
- 网表编码与官方格式逐字节一致。

### 对 P5 的最终判断（修正）

**P5 可以被本方案替代，前提是实现"按处理器选择 + 过滤售罄 + 按选中处理器报价"。**

不需要第三方供应商，因为：
- 协议有 357 个处理器仍有晶体管可买；
- 用户用自己的钱包买、自己流片、自己开通；
- 平台只负责挑选可用处理器、展示真实价格、构造 calldata、核验结果。

我第一版说"P5 在当前状态下没有正确实现方式"，那是因为测量不完整，**该结论作废**。
