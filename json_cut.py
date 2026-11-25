
import json

INPUT_FILE = "Talking_data.jsonl"
OUTPUT_FILE = "Talking_data_single.jsonl"


def split_conversations(conversations):
    results = []

    for conversation in conversations:
        messages = conversation.get("messages", [])

        # systemメッセージを取得
        system_messages = [
            msg for msg in messages
            if msg["role"] == "system"
        ]

        pending_user = None

        for msg in messages:
            role = msg["role"]

            # ユーザーの発言を記録
            if role == "user":
                pending_user = msg

            # 次のassistant発言と組み合わせる
            elif role == "assistant" and pending_user is not None:

                sample = {
                    "messages": (
                        system_messages
                        + [pending_user, msg]
                    )
                }

                results.append(sample)
                pending_user = None

    return results


# JSON読み込み
with open(INPUT_FILE, "r", encoding="utf-8") as f:
    conversations = json.load(f)

# 分割
dataset = split_conversations(conversations)

# JSONLとして保存
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    for sample in dataset:
        f.write(
            json.dumps(sample, ensure_ascii=False) + "\n"
        )

print("変換完了！")
print(f"元のスレッド数: {len(conversations)}")
print(f"生成した学習サンプル数: {len(dataset)}")
print(f"保存先: {OUTPUT_FILE}")
