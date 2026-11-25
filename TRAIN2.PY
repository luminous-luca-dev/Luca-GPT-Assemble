
# ==========================================
# 1. インポート
# ==========================================
# UnslothはTRL・Transformersより先に読み込む
from unsloth import FastLanguageModel

import torch
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

# ==========================================
# 2. モデルとトークナイザーの読み込み
# ==========================================
max_seq_length = 2048
model_name = "unsloth/Qwen3-4B-unsloth-bnb-4bit"

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=model_name,
    max_seq_length=max_seq_length,
    dtype=None,
    load_in_4bit=True,
)

# ==========================================
# 3. LoRA設定
# ==========================================
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj"
    ],
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

# ==========================================
# 4. データセット読み込み
# ==========================================
# messages形式のまま読み込む
# 手動でChatML文字列に変換しない
dataset = load_dataset(
    "json",
    data_files="Talking_data_single.jsonl",
    split="train"
)

print("データセット件数:", len(dataset))
print("データ形式:", dataset[0])

# ==========================================
# 5. 学習設定
# ==========================================
training_args = SFTConfig(
    output_dir="models/outputs",

    # 会話形式のデータを使用
    max_length=max_seq_length,
    packing=False,
    dataset_num_proc=2,

    # ★ assistantの発言だけをLoss対象にする
    assistant_only_loss=True,

    per_device_train_batch_size=1,
    gradient_accumulation_steps=4,

    warmup_steps=1,
    num_train_epochs=3,
    learning_rate=1e-4,

    fp16=not torch.cuda.is_bf16_supported(),
    bf16=torch.cuda.is_bf16_supported(),

    optim="adamw_8bit",
    weight_decay=0.01,
    lr_scheduler_type="linear",

    logging_steps=1,
    seed=3407,
    report_to="none",
)

trainer = SFTTrainer(
    model=model,
    processing_class=tokenizer,
    train_dataset=dataset,
    args=training_args,
)

print("Chat Template:")
print(tokenizer.chat_template)

print("EOS token:", tokenizer.eos_token)
print("EOS token ID:", tokenizer.eos_token_id)

# ==========================================
# 6. 学習
# ==========================================
print("学習を開始します...")
trainer_stats = trainer.train()
print("学習完了！")

# ==========================================
# 7. GGUF変換
# ==========================================
print("GGUF形式に変換・保存中...")

model.save_pretrained_gguf(
    "models/luca_gpt_05_single_4B_gguf",
    tokenizer,
    quantization_method="q4_k_m"
)

print("すべて完了！")
