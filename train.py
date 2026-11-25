import torch
from datasets import load_dataset
from unsloth import FastLanguageModel
from unsloth.chat_templates import get_chat_template
from trl import SFTTrainer
from transformers import TrainingArguments

# ==========================================
# 1. モデルとトークナイザーの読み込み
# ==========================================
max_seq_length = 2048  # チャットなので2048あれば十分（VRAM節約にもなる）
model_name = "unsloth/Qwen3-4B-unsloth-bnb-4bit" # 重ければ Qwen3-4B や Qwen2.5-7B-Instruct-bnb-4bit に変更

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = model_name,
    max_seq_length = max_seq_length,
    dtype = None,
    load_in_4bit = True,
)

# ==========================================
# 2. LoRA（追加学習アダプタ）の設定
# ==========================================
model = FastLanguageModel.get_peft_model(
    model,
    r = 16, # 学習の表現力（16〜32が定番）
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                      "gate_proj", "up_proj", "down_proj"],
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
    use_gradient_checkpointing = "unsloth", # VRAMを大幅に節約するUnsloth独自機能
    random_state = 3407,
)

# ==========================================
# 3. データセットの読み込みとChatML形式への整形
# ==========================================
tokenizer = get_chat_template(
    tokenizer,
    chat_template = "chatml", # QwenシリーズはChatML形式
)

def formatting_prompts_func(examples):
    convos = examples["messages"]
    texts = [
        tokenizer.apply_chat_template(
            convo, tokenize = False, add_generation_prompt = False
        )
        for convo in convos
    ]
    return { "text" : texts }

dataset = load_dataset("json", data_files = "Talking_data.jsonl", split = "train")
dataset = dataset.map(formatting_prompts_func, batched = True)

print("===== ORIGINAL MESSAGES =====")
print(dataset[0]["messages"])

print("\n===== FORMATTED TEXT =====")
print(dataset[0]["text"])

print("\n===== TOKENIZED LENGTH =====")
tokens = tokenizer(
    dataset[0]["text"],
    add_special_tokens=False
)
print(len(tokens["input_ids"]))

# ==========================================
# 4. 学習パラメータの設定（RTX 4060 8GB向け）
# ==========================================
trainer = SFTTrainer(
    model = model,
    tokenizer = tokenizer,
    train_dataset = dataset,
    dataset_text_field = "text",
    max_seq_length = max_seq_length,
    dataset_num_proc = 2,
    packing = False,
    args = TrainingArguments(
        per_device_train_batch_size = 1, # VRAM 8GBなので1に固定
        gradient_accumulation_steps = 4, # 4回分溜めてから更新（実質バッチサイズ4）
        warmup_steps = 5,
        num_train_epochs = 2,            # データが約36件と少ないため、5周（エポック）学習させる
        learning_rate = 2e-4,
        fp16 = not torch.cuda.is_bf16_supported(),
        bf16 = torch.cuda.is_bf16_supported(), # RTX 4060はbf16対応なので高速＆安定
        logging_steps = 1,
        optim = "adamw_8bit",            # 8bitオプティマイザでVRAM節約
        weight_decay = 0.01,
        lr_scheduler_type = "linear",
        seed = 3407,
        output_dir = "models/outputs",
    ),
)

# 学習実行！
print("学習を開始します...")
trainer_stats = trainer.train()
print("学習完了！")

# ==========================================
# 5. LM Studioで使えるGGUF形式に書き出し
# ==========================================
print("GGUF形式（Q4_K_M）に変換・保存中...（数分かかります）")
model.save_pretrained_gguf(
    "models/luca_gpt_02_4B_gguf",
    tokenizer,
    quantization_method = "q4_k_m"
)
print("すべて完了！ 'luca_gpt_gguf' フォルダ内の .gguf ファイルをLM Studioに読み込ませてください。")