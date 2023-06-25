
import sys
import json
import re
import torch
from PIL import Image
from transformers import DonutProcessor, VisionEncoderDecoderModel


def image_to_text(filepath):
  processor = DonutProcessor.from_pretrained("naver-clova-ix/donut-base-finetuned-docvqa")
  model = VisionEncoderDecoderModel.from_pretrained("naver-clova-ix/donut-base-finetuned-docvqa")

  device = "cuda" if torch.cuda.is_available() else "cpu"
  model.to(device)
  # load document image
  image = Image.open(sys.argv[1]).convert("RGB")

  # prepare decoder inputs
  task_prompt = "<s_docvqa><s_question>{user_input}</s_question><s_answer>"
  question = "What does the logo say?"
  prompt = task_prompt.replace("{user_input}", question)
  decoder_input_ids = processor.tokenizer(prompt, add_special_tokens=False, return_tensors="pt").input_ids

  pixel_values = processor(image, return_tensors="pt").pixel_values

  outputs = model.generate(
      pixel_values.to(device),
      decoder_input_ids=decoder_input_ids.to(device),
      max_length=model.decoder.config.max_position_embeddings,
      early_stopping=True,
      pad_token_id=processor.tokenizer.pad_token_id,
      eos_token_id=processor.tokenizer.eos_token_id,
      use_cache=True,
      num_beams=1,
      bad_words_ids=[[processor.tokenizer.unk_token_id]],
      return_dict_in_generate=True,
  )

  sequence = processor.batch_decode(outputs.sequences)[0]
  sequence = sequence.replace(processor.tokenizer.eos_token, "").replace(processor.tokenizer.pad_token, "")
  sequence = re.sub(r"<.*?>", "", sequence, count=1).strip()  # remove first task start token
  return processor.token2json(sequence)


def main():
  caption = image_to_text(sys.argv[1])
  print(json.dumps(caption))

if __name__ == "__main__":
    main()

