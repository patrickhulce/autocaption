
import sys
import json
import re
import torch
from PIL import Image
from transformers import DonutProcessor, VisionEncoderDecoderModel


def image_to_text(filepath):
    processor = DonutProcessor.from_pretrained(
        "naver-clova-ix/donut-base-finetuned-cord-v2")
    model = VisionEncoderDecoderModel.from_pretrained(
        "naver-clova-ix/donut-base-finetuned-cord-v2")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    # load document image
    image = Image.open(filepath).convert("RGB")

    # prepare decoder inputs
    task_prompt = "<s_cord-v2>"
    decoder_input_ids = processor.tokenizer(
        task_prompt, add_special_tokens=False, return_tensors="pt").input_ids

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
    sequence = sequence.replace(processor.tokenizer.eos_token, "").replace(
        processor.tokenizer.pad_token, "")
    # remove first task start token
    sequence = re.sub(r"<.*?>", "", sequence, count=1).strip()
    return processor.token2json(sequence)


def main():
    caption = image_to_text(sys.argv[1])
    print(json.dumps(caption))


if __name__ == "__main__":
    main()
